import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, On, RenderInput } from 'claude-code'

import * as L from './logic'
import type { Kind } from './types'

// Pulse watches tool calls and task lists and draws them in its own pane.
// It observes only: no tools, no prompt text, no model calls, no denials.

export const PANE_ID = 'pulse'
export const TITLE = 'Pulse'
const GRAPH_ROWS = 11

const job = atom({ plugin: 'pulse', key: 'job' } as const, L.emptyJob())
const steps = atom({ plugin: 'pulse', key: 'steps' } as const, [] as L.Model['steps'])
const buckets = atom({ plugin: 'pulse', key: 'buckets' } as const, [] as L.GraphProps['buckets'])
const pinned = atom({ plugin: 'pulse', key: 'pinned' } as const, null as L.GraphProps['pinned'])
const isPaneOpen = atom({ plugin: 'pulse', key: 'isPaneOpen' } as const, false)
const lastCall = atom({ plugin: 'pulse', key: 'lastCall' } as const, null as L.GraphProps['last'])
const clientFault = atom({ plugin: 'pulse', key: 'clientFault' } as const, null as string | null)
// Kept in $.store too, so they last across sessions.
const width = atom({ plugin: 'pulse', key: 'width' } as const, L.WIDTH.initial as number)
const mouse = atom({ plugin: 'pulse', key: 'mouse' } as const, true as boolean)
// This session only: the detail line shows the pointer and what it mapped to.
const mouseDebug = atom({ plugin: 'pulse', key: 'mouseDebug' } as const, false as boolean)

const USAGE = `Usage: /pulse [doctor | width <${L.WIDTH.min}-${L.WIDTH.max}> | mouse on|off|debug|debug off]`

// The module's own bookkeeping; a hot reload starts it over.
type Ctx = {
  lastWasCommand: boolean
  caught: string[]
  clientSurfaces: Set<string>
}

async function noteError($: Dollar, ctx: Ctx, where: string, error: unknown) {
  const text = `${where}: ${error instanceof Error ? error.message : String(error)}`
  if (ctx.caught.includes(text)) return
  ctx.caught.push(text)
  if (ctx.caught.length > 20) ctx.caught.shift()
  $.ui.log(`pulse ${text}`, { to: 'debug' })
}

async function readModel($: Dollar): Promise<L.Model> {
  return { job: L.normalizeJob(await read($, job)), steps: L.normalizeSteps(await read($, steps)) }
}

async function apply($: Dollar, ev: L.JobEvent) {
  const next = L.reduce(await readModel($), ev)
  await update($, job, () => next.job)
  await update($, steps, () => next.steps)
  return next
}

async function setPane($: Dollar, isOpen: boolean) {
  if (isOpen) {
    // Reopening gives a graph that failed another try.
    await update($, clientFault, () => null)
    await $.ui.open({ id: PANE_ID, title: TITLE, columns: L.clampWidth(await read($, width)) })
  } else {
    await $.ui.close({ id: PANE_ID })
  }
  await update($, isPaneOpen, () => isOpen)
  await $.store.set('isPaneOpen', isOpen)
  return isOpen
}

// Saves the width and, with the pane open, opens it again at that width so it resizes now.
async function setWidth($: Dollar, columns: number) {
  const next = L.clampWidth(columns)
  await update($, width, () => next)
  await $.store.set('width', next)
  if (await read($, isPaneOpen)) await $.ui.open({ id: PANE_ID, title: TITLE, columns: next })
  return next
}

async function setMouse($: Dollar, isOn: boolean) {
  await update($, mouse, () => isOn)
  await $.store.set('mouse', isOn)
}

// The Client's region: the body less the right margin, and exactly the rows the graph draws.
function region(e: RenderInput<'Pane'>) {
  const columns = Math.max(1, (e.props?.bodyColumns ?? 60) - L.MARGIN)
  return { columns, rows: L.graphHeight(columns, Math.max(1, Math.min(GRAPH_ROWS, e.props?.scroll?.bodyRows ?? GRAPH_ROWS))) }
}

async function graphProps($: Dollar, size: { columns: number; rows: number }): Promise<L.GraphProps> {
  const m = await readModel($)
  return {
    job: m.job,
    steps: m.steps,
    buckets: L.normalizeBuckets(await read($, buckets)),
    pinned: L.normalizePinned(await read($, pinned)),
    last: L.normalizeLastCall(await read($, lastCall)),
    now: await $.clock.now(),
    ...size,
    mouse: (await read($, mouse)) !== false,
    debug: (await read($, mouseDebug)) === true,
  }
}

function drawSummary($: Dollar, e: RenderInput<'Pane'>, p: L.GraphProps, note?: string) {
  const { Box, Text } = $.ui.resolve(e)
  const cols = region(e).columns
  const lines = L.textSummary(p)
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={`line-${i}`} bold={i === 0} dimColor={i > 0 && i < lines.length - 2} wrap="truncate-end">{L.fit(line, cols)}</Text>
      ))}
      {note && <Text dimColor wrap="truncate-end">{L.fit(note, cols)}</Text>}
    </Box>
  )
}

export function registerPulse(on: On) {
  const ctx: Ctx = { lastWasCommand: false, caught: [], clientSurfaces: new Set() }
  // Where each running call started, so a failure lands in the right bucket.
  const started = new Map<string, { at: number; kind: Exclude<Kind, 'fail'> }>()

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pulse', description: 'Pulse: toggle the live activity pane, or /pulse doctor, width, mouse', argumentHint: 'doctor | width <n> | mouse on|off', immediate: true })
    const savedWidth = L.clampWidth(await $.store.get('width'))
    await update($, width, () => savedWidth)
    const isMouseOn = (await $.store.get('mouse')) !== false
    await update($, mouse, () => isMouseOn)
    // Reopen the pane only for someone who left it open.
    if ((await $.store.get('isPaneOpen')) === true) {
      await update($, isPaneOpen, () => true)
      void $.ui.open({ id: PANE_ID, title: TITLE, columns: savedWidth }).catch(error => noteError($, ctx, 'ui.open', error))
    }
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'session.start', next.error), next(e)))

  on('prompt.submit', ($, e, next) => {
    ctx.lastWasCommand = e.command !== undefined || e.text.trimStart().startsWith('/')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text.trim() && !ctx.lastWasCommand) {
      const before = L.normalizeJob(await read($, job))
      const after = await apply($, { type: 'job', text: e.text, now: await $.clock.now() })
      if (after.job.startedAt !== before.startedAt) await update($, pinned, () => null)
    }
    ctx.lastWasCommand = false
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'turn.start', next.error), next(e)))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const kind = L.kindOf(tool)
    const isMain = e.agentId === undefined
    const now = await $.clock.now()
    // Subagents' calls show on the wave; only the main loop moves the steps.
    if (kind) {
      const path = L.toolPath(e)
      started.set(e.tool_use_id, { at: now, kind })
      await update($, buckets, b => L.addCall(L.normalizeBuckets(b), { at: now, kind, file: path ? L.basename(path) : undefined }))
      if (isMain) {
        await apply($, { type: 'tool.start', now })
        await update($, lastCall, () => ({ tool, summary: L.callSummary(tool, e), at: now }))
      }
    }
    if (isMain && tool === 'AskUserQuestion') await apply($, { type: 'needs-you' })

    const ran = await next(e)

    const isError = ran.deny !== undefined || ran.isError === true
    const start = started.get(e.tool_use_id)
    started.delete(e.tool_use_id)
    if (start && isError) await update($, buckets, b => L.markFailed(L.normalizeBuckets(b), start.at, start.kind))
    if (!isMain) return ran
    if (kind) await apply($, { type: 'tool.end', isError })
    if (isError) return ran
    const result = (ran.result ?? {}) as Record<string, unknown>
    const done = await $.clock.now()
    if (tool === 'TaskCreate') {
      const task = (result.task ?? {}) as Record<string, unknown>
      await apply($, { type: 'task.create', id: String(task.id ?? e.tool_use_id), name: L.field(task, 'subject') ?? L.field(e, 'subject') ?? '' })
    } else if (tool === 'TaskUpdate') {
      await apply($, { type: 'task.update', id: L.field(e, 'taskId') ?? '', status: L.field(e, 'status'), name: L.field(e, 'subject'), now: done })
    } else if (tool === 'TodoWrite') {
      const todos = (e as { todos?: unknown }).todos
      await apply($, { type: 'todos', todos: Array.isArray(todos) ? todos : [], now: done })
    } else if (tool === 'ExitPlanMode') {
      await apply($, { type: 'plan', text: L.field(result, 'plan') ?? L.field(e, 'plan') ?? '', now: done })
    }
    return ran
  }).catch(async ($, e, next) => (await noteError($, ctx, 'tool.call', next.error), next(e)))

  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/.test(e.notification_type ?? '')) await apply($, { type: 'needs-you' })
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'Notification', next.error), next(e)))

  on('classic.StopFailure', async ($, e, next) => {
    await apply($, { type: 'error' })
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'StopFailure', next.error), next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await apply($, { type: 'turn.end', isAborted: e.isAborted === true, now: await $.clock.now() })
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'turn.complete', next.error), next(e)))

  on('command.run', { command: 'pulse' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    const [word, value] = arg.split(' ')
    if (word === 'width' && value === undefined) return { text: `Pulse width: ${L.clampWidth(await read($, width))} columns.` }
    if (word === 'width') {
      const n = Number(value)
      if (!/^\d+$/.test(value!) || !Number.isFinite(n)) return { text: USAGE }
      const set = await setWidth($, n)
      return { text: `Pulse width: ${set} columns.${set !== n ? ` (Limits are ${L.WIDTH.min} to ${L.WIDTH.max}.)` : ''}` }
    }
    if (word === 'mouse' && (value === 'on' || value === 'off')) {
      await setMouse($, value === 'on')
      return { text: value === 'on' ? 'Pulse mouse on: hover and click the graph.' : 'Pulse mouse off: the graph ignores the pointer; ← → and Enter still work.' }
    }
    if (arg === 'mouse debug' || arg === 'mouse debug on' || arg === 'mouse debug off') {
      const isOn = arg !== 'mouse debug off'
      await update($, mouseDebug, () => isOn)
      return { text: isOn ? 'Pulse mouse debug on: the detail line shows the last pointer x,y and what it mapped to.' : 'Pulse mouse debug off.' }
    }
    if (word === 'mouse' && value === undefined) return { text: `Pulse mouse: ${(await read($, mouse)) !== false ? 'on' : 'off'}.` }
    if (arg === 'doctor') {
      const { version } = await $.session.version()
      const fault = await read($, clientFault)
      const running = [...ctx.clientSurfaces].join(', ')
      return {
        text: [
          'Pulse doctor',
          `Claude Code: ${version}`,
          `Pane: ${(await read($, isPaneOpen)) ? 'open' : 'closed'}`,
          `Graph: ${fault ? `failed (${fault}); showing the text summary` : running ? `running on ${running}` : 'not running'}`,
          `Width: ${L.clampWidth(await read($, width))} columns · Mouse: ${(await read($, mouse)) !== false ? 'on' : 'off'}`,
          `Errors caught:${ctx.caught.length ? '\n- ' + ctx.caught.join('\n- ') : ' none'}`,
        ].join('\n'),
      }
    }
    if (arg) return { text: USAGE }
    return { text: (await setPane($, !(await read($, isPaneOpen)))) ? 'Pulse pane opened.' : 'Pulse pane closed.' }
  }).catch(async ($, e, next) => (await noteError($, ctx, 'command.run', next.error), { text: 'Pulse hit an error; see /pulse doctor.' }))

  // The person closing the pane by hand keeps the saved flag honest.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    await $.store.set('isPaneOpen', false)
    return closed
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ui.close', next.error), next(e)))

  // ── The graph's messages ─────────────────────────────────────────────────

  // A click (or Enter) on a column or step pins it; the same one again unpins.
  // A click on [−] or [+] (or the - and + keys) resizes the pane by one step.
  on('ui.message', async ($, e, next) => {
    const data = (e.data ?? {}) as { type?: unknown; pin?: unknown; by?: unknown }
    if (data.type === 'ready') ctx.clientSurfaces.add(e.surface)
    if (data.type === 'resize' && (data.by === 1 || data.by === -1)) {
      await setWidth($, L.clampWidth(await read($, width)) + data.by * L.WIDTH.step)
    }
    if (data.type === 'pin') {
      const pin = L.normalizePinned(data.pin)
      await update($, pinned, now => (L.sameHover(L.normalizePinned(now), pin) ? null : pin))
    }
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ui.message', next.error), next(e)))

  on('ui.fault', async ($, e, next) => {
    await noteError($, ctx, `graph ${e.phase} on ${e.surface}`, e.reason)
    ctx.clientSurfaces.delete(e.surface)
    await update($, clientFault, () => e.reason)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ── Drawing ──────────────────────────────────────────────────────────────

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    const size = region(e)
    const p = await graphProps($, size)
    const fault = await read($, clientFault)
    if ((e.surface === 'terminal' || e.surface === 'desktop') && !fault) {
      const { Client } = $.ui.resolve(e)
      return <Client key="graph" module="./graph.tsx" props={p} width={size.columns} height={size.rows} />
    }
    return drawSummary($, e, p, fault ? 'The live graph stopped; showing a summary. /pulse doctor says why.' : undefined)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'Pane', next.error), next(e)))
}

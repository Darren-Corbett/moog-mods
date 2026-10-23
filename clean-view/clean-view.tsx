import { atom, read, update } from 'claude-code'
import type { EngineInterface as Dollar, On, PluginOptions, ResolveInput } from 'claude-code'

import * as L from './logic'
import { drawPane, PANE_ID } from './pane'
import type { Checklist, JobRecord, Mode } from './types'

// The Claude Code version this was last tested on; a newer one gets one toast.
export const TESTED_VERSION = '2.1.308'

const mode = atom({ plugin: 'clean-view', key: 'mode' } as const, 'focus' as Mode)
const checklist = atom({ plugin: 'clean-view', key: 'checklist' } as const, L.emptyChecklist())
const folded = atom({ plugin: 'clean-view', key: 'folded' } as const, L.emptyFolded())
const errors = atom({ plugin: 'clean-view', key: 'errors' } as const, [] as string[])
const clockNow = atom({ plugin: 'clean-view', key: 'now' } as const, 0)
const isUnfolded = atom({ plugin: 'clean-view', key: 'isUnfolded' } as const, false)
const history = atom({ plugin: 'clean-view', key: 'history' } as const, [] as JobRecord[])
const isPaneOpen = atom({ plugin: 'clean-view', key: 'isPaneOpen' } as const, false)

const NUDGE = {
  id: 'clean-view:task-lists',
  scope: 'session',
  text: 'For work that will take more than about three tool calls, first create a task list of 2 to 8 steps and keep it updated as you go. Step names: under 50 characters, start with a verb, plain words (a short file or function name is fine; no paths, commands or code). Skip this for quick questions and one-shot edits.',
} as const

const DENIAL = /doesn.t want to proceed|was rejected|user (denied|rejected|declined)/i
// An empty Box draws nothing in the row's place.
const hidden = (e: ResolveInput, $: Dollar) => {
  const { Box } = $.ui.resolve(e)
  return <Box />
}

type Timer = { cancel: () => void }

// The module's own bookkeeping for one activation; a hot reload starts it over.
type Ctx = {
  roots: string[]
  lastWasCommand: boolean
  isPlanMode: boolean
  ticker: Timer | null
  collapse: Timer | null
  pendingReads: Map<string, string>
  seen: Set<string>
  caught: string[]
  drawn: Set<string>
}

async function noteError($: Dollar, ctx: Ctx, where: string, error: unknown) {
  const text = `${where}: ${error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error)}`
  if (ctx.seen.has(text)) return
  ctx.seen.add(text)
  ctx.caught.push(text)
  $.ui.log(`clean-view ${text}`)
  await update($, errors, list => [...list, text].slice(-20)).catch(() => undefined)
}

async function tick($: Dollar) {
  const t = await $.clock.now()
  await update($, clockNow, () => t)
}

// The elapsed-time clock runs only while a job is working or waiting.
async function syncTicker($: Dollar, ctx: Ctx, c: Checklist) {
  if (L.isTicking(c) && !ctx.ticker) {
    await tick($)
    ctx.ticker = $.clock.every(1000, () => void tick($).catch(() => undefined))
  } else if (!L.isTicking(c) && ctx.ticker) {
    ctx.ticker.cancel()
    ctx.ticker = null
  }
}

async function apply($: Dollar, ctx: Ctx, event: L.ChecklistEvent) {
  const c = await update($, checklist, value => L.reduce(value, event))
  const record = event.type === 'turn.end' ? L.jobRecord(c) : null
  if (record) {
    const list = await update($, history, h => L.addHistory(L.normalizeHistory(h), record))
    await $.store.set('history', list)
  }
  await syncTicker($, ctx, c)
  if (c.phase === 'done' && !c.isCollapsed && !ctx.collapse) {
    ctx.collapse = $.clock.after(5000, () => {
      ctx.collapse = null
      void apply($, ctx, { type: 'collapse' }).catch(() => undefined)
    })
  }
  return c
}

async function setMode($: Dollar, next: Mode, isCycle = false) {
  await update($, mode, () => next)
  await $.store.set('mode', next)
  const isFirstCycle = isCycle && (await $.store.get('hintedHelp')) !== true
  if (isFirstCycle) await $.store.set('hintedHelp', true)
  $.ui.toast(`Clean View: ${L.modeLabel(next)}${isFirstCycle ? ' · /clean help explains the modes' : ''}`)
  return next
}

async function setPane($: Dollar, isOpen: boolean) {
  if (isOpen) await $.ui.open({ id: PANE_ID, title: 'Progress' })
  else await $.ui.close({ id: PANE_ID })
  await update($, isPaneOpen, () => isOpen)
  await $.store.set('isPaneOpen', isOpen)
  return isOpen
}
const togglePane = async ($: Dollar) => setPane($, !(await read($, isPaneOpen)))
const cycleMode = async ($: Dollar) => setMode($, L.nextMode(await read($, mode)), true)

const isBeforeEdit = (ids: readonly string[], id: unknown) => typeof id === 'string' && ids.includes(id)

type RowProps = { tool?: unknown; input?: unknown; isErrored?: boolean; isInterrupted?: boolean; isExpanded?: boolean; tool_use_id?: unknown }

// A tool row is left to the engine unless focus or calm mode says otherwise.
// ctrl+o (`isExpanded`) and the band's `show` always give the engine's rows back.
async function rowDecision($: Dollar, ctx: Ctx, props: RowProps) {
  const m = await read($, mode)
  if (m === 'band' || m === 'off' || props.isExpanded) return 'keep'
  if (m === 'calm') return 'hide'
  if (await read($, isUnfolded)) return 'keep'
  const f = await read($, folded)
  // A ToolResult carries no input: it folds with the call it belongs to.
  if (props.input === undefined) return props.isErrored !== true && isBeforeEdit(f.ids, props.tool_use_id) ? 'hide' : 'keep'
  const call = { tool: String(props.tool ?? ''), input: props.input, isErrored: props.isErrored === true || props.isInterrupted === true }
  const d = L.foldDecision(call, { roots: ctx.roots, isBeforeEdit: isBeforeEdit(f.beforeEdit, props.tool_use_id) })
  return d === 'fold' ? 'hide' : d
}

export function registerCleanView(on: On, options: PluginOptions) {
  const ctx: Ctx = {
    roots: [], lastWasCommand: false, isPlanMode: false, ticker: null, collapse: null,
    pendingReads: new Map(), seen: new Set(), caught: [], drawn: new Set(),
  }

  on('session.start', async ($, e, next) => {
    const stored = await $.store.get('mode')
    if (typeof stored === 'string' && L.isMode(stored)) await update($, mode, () => stored)
    const saved = L.normalizeHistory(await $.store.get('history'))
    await update($, history, () => saved)
    await $.command.register({ name: 'clean', description: 'Clean View: focus, band, calm, off, pane, help or doctor', argumentHint: 'focus|band|calm|off|pane|help|doctor', immediate: true })
    // Reopen the pane only for someone who left it open.
    if ((await $.store.get('isPaneOpen')) === true) {
      await update($, isPaneOpen, () => true)
      void $.ui.open({ id: PANE_ID, title: 'Progress' }).catch(error => noteError($, ctx, 'ui.open', error))
    }
    ctx.roots = [e.cwd]
    for (let dir = e.cwd; dir.length > 1; dir = dir.replace(/\/[^/]*$/, '') || '/') {
      if (await $.fs.exists(`${dir}/.git`).catch(() => false)) { if (dir !== e.cwd) ctx.roots.push(dir); break }
    }
    const { version } = await $.session.version()
    if (L.isNewerVersion(version, TESTED_VERSION)) $.ui.toast(`Clean View was tested on ${TESTED_VERSION}; if anything looks wrong, run /clean band`)
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'session.start', next.error), next(e)))

  if (options.nudgeTaskLists === true) {
    on('prompt.compose', async ($, e, next) => {
      const composed = await next(e)
      return { ...composed, sections: [...composed.sections, NUDGE] }
    }).catch(($, e, next) => next(e))
  }

  on('prompt.submit', ($, e, next) => {
    ctx.lastWasCommand = e.command !== undefined || e.text.trimStart().startsWith('/')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', ($, e, next) => {
    ctx.isPlanMode = e.permission_mode === 'plan'
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text.trim() && !ctx.lastWasCommand) {
      const before = await read($, checklist)
      const c = await apply($, ctx, { type: 'job', text: e.text, now: await $.clock.now() })
      if (c.startedAt !== before.startedAt) {
        ctx.collapse?.cancel()
        ctx.collapse = null
        ctx.pendingReads.clear()
        await update($, folded, () => L.emptyFolded())
      }
      if (ctx.isPlanMode) await apply($, ctx, { type: 'planning' })
      await update($, isUnfolded, () => false)
    }
    ctx.lastWasCommand = false
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'turn.start', next.error), next(e)))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    const path = L.toolPath(e)
    await apply($, ctx, { type: 'tool.start', tool, input: e, now: await $.clock.now() })
    if (tool === 'AskUserQuestion') await apply($, ctx, { type: 'needs-you', reason: 'Claude has a question for you' })
    if (tool === 'EnterPlanMode') await apply($, ctx, { type: 'planning' })
    if (L.foldDecision({ tool, input: e }, { roots: ctx.roots, isBeforeEdit: false }) === 'fold') {
      await update($, folded, f => L.addFolded(f, tool, e, e.tool_use_id))
      if (tool === 'Read' && path) ctx.pendingReads.set(path, e.tool_use_id)
    }
    const readId = L.EDITS.has(tool) && path ? ctx.pendingReads.get(path) : undefined
    if (readId) await update($, folded, f => ({ ...f, beforeEdit: [...f.beforeEdit, readId].slice(-50) }))

    const ran = await next(e)

    const isError = ran.deny !== undefined || ran.isError === true
    const result = (ran.result ?? {}) as Record<string, unknown>
    const now = await $.clock.now()
    await apply($, ctx, { type: 'tool.end', isError, isDenied: isError && DENIAL.test(ran.deny ?? ran.text ?? '') })
    if (isError) return ran
    if (tool === 'TaskCreate') {
      const task = (result.task ?? {}) as Record<string, unknown>
      await apply($, ctx, { type: 'task.create', id: String(task.id ?? e.tool_use_id), name: L.field(task, 'subject') ?? L.field(e, 'subject') ?? '' })
    } else if (tool === 'TaskUpdate') {
      const status = L.field(e, 'status')
      if (status) ctx.pendingReads.clear()
      await apply($, ctx, { type: 'task.update', id: L.field(e, 'taskId') ?? '', status, name: L.field(e, 'subject'), now })
    } else if (tool === 'TodoWrite') {
      const todos = (e as { todos?: unknown }).todos
      ctx.pendingReads.clear()
      await apply($, ctx, { type: 'todos', todos: Array.isArray(todos) ? todos : [], now })
    } else if (tool === 'ExitPlanMode') {
      await apply($, ctx, { type: 'plan', text: L.field(result, 'plan') ?? '', now })
    }
    return ran
  }).catch(async ($, e, next) => (await noteError($, ctx, 'tool.call', next.error), next(e)))

  on('classic.Notification', async ($, e, next) => {
    if (/permission|elicitation/.test(e.notification_type ?? '')) await apply($, ctx, { type: 'needs-you', reason: e.message ?? '' })
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'Notification', next.error), next(e)))

  on('classic.PermissionDenied', async ($, e, next) => {
    await apply($, ctx, { type: 'denied' })
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'PermissionDenied', next.error), next(e)))

  on('classic.StopFailure', async ($, e, next) => {
    await apply($, ctx, { type: 'api-error', errorType: String(e.error ?? 'unknown'), details: e.error_details, now: await $.clock.now() })
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'StopFailure', next.error), next(e)))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await apply($, ctx, { type: 'turn.end', reason: e.isAborted ? 'aborted' : e.reason, now: await $.clock.now() })
    }
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'turn.complete', next.error), next(e)))

  on('command.run', { command: 'clean' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'doctor') {
      const { version } = await $.session.version()
      return {
        text: [
          `Clean View doctor`,
          `Claude Code: ${version} (tested on ${TESTED_VERSION})`,
          `Mode: ${await read($, mode)}`,
          `Drawn this session: ${[...ctx.drawn].join(', ') || 'nothing yet'}`,
          `Errors caught:${ctx.caught.length ? '\n- ' + ctx.caught.join('\n- ') : ' none'}`,
        ].join('\n'),
      }
    }
    if (arg === 'help') return { text: `Clean View modes\n${L.helpText()}\n\n/clean pane toggles the progress pane; /clean doctor checks the mod.` }
    if (arg === 'pane') return { text: (await togglePane($)) ? 'Progress pane opened.' : 'Progress pane closed.' }
    if (arg && !L.isMode(arg)) return { text: 'Usage: /clean [focus|band|calm|off|pane|help|doctor]' }
    const next = arg && L.isMode(arg) ? await setMode($, arg) : await cycleMode($)
    return { text: `Clean View: ${L.modeLabel(next)}` }
  }).catch(async ($, e, next) => (await noteError($, ctx, 'command.run', next.error), { text: 'Clean View hit an error; see /clean doctor.' }))

  // The person closing the pane by hand (or our own close) keeps the saved flag honest.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const closed = await next(e)
    await update($, isPaneOpen, () => false)
    await $.store.set('isPaneOpen', false)
    return closed
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ui.close', next.error), next(e)))

  // ── Drawing ──────────────────────────────────────────────────────────────

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props?.hasSurvey) return next(e)
    ctx.drawn.add('AbovePrompt')
    const { Box, Text, Button } = $.ui.resolve(e)
    const m = await read($, mode)
    const c = await read($, checklist)
    const cols = Math.max(20, e.props?.bodyColumns ?? 80)
    const modeButton = <Button key="mode" label={`Clean View: ${L.modeLabel(m)}`} onPress={() => cycleMode($)} />
    if (m === 'off') return <Box flexDirection="row" justifyContent="flex-end">{modeButton}</Box>
    const paneButton = <Button key="pane" label="Pane" onPress={() => togglePane($)} />
    if (!L.isVisible(c)) return <Box flexDirection="row" justifyContent="flex-end">{paneButton}{modeButton}</Box>

    const head = L.header(c, await read($, clockNow))
    const tone = head.tone === 'plain' ? undefined : head.tone
    const room = cols - L.modeLabel(m).length - 18 - (head.badge ? head.badge.length + 3 : 0) - (head.detail ? head.detail.length + 2 : 0)
    // The Pane button takes its seat only where the header still fits whole beside it.
    const hasPaneButton = room - L.PANE_BUTTON_WIDTH >= head.text.length
    const isFull = !(c.phase === 'done' && c.isCollapsed)
    const col = L.nameColumn(cols)
    const nextIndex = c.tasks.findIndex(t => t.status === 'upcoming')
    const done = c.tasks.filter(t => t.status === 'done').length
    const f = await read($, folded)
    const unfolded = await read($, isUnfolded)
    const now = await read($, clockNow)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" flexShrink={1}>
            {head.badge && <Text inverse bold color={c.phase === 'planning' ? 'planMode' : 'warning'}> {head.badge} </Text>}
            <Text bold color={tone} wrap="truncate-end">{head.badge ? ' ' : ''}{L.fit(head.text, Math.max(8, room - (hasPaneButton ? L.PANE_BUTTON_WIDTH : 0)))}</Text>
            {head.detail && <Text dimColor>  {head.detail}</Text>}
          </Box>
          <Box flexDirection="row">{hasPaneButton && paneButton}{modeButton}</Box>
        </Box>
        {isFull && cols >= L.MIN_STEP_COLUMNS && c.tasks.map((t, i) => {
          const isActive = t.status === 'active'
          const mark = t.status === 'done' ? '✓' : isActive ? (c.phase === 'needs-you' ? '‖' : '▶') : '○'
          return (
            <Box key={`step-${i}`} flexDirection="row">
              <Text color={t.status === 'done' ? 'success' : undefined} bold={isActive}>{mark} </Text>
              <Text bold={isActive} dimColor={!isActive} wrap="truncate-end">{L.fit(t.name, col).padEnd(col)}</Text>
              <Text dimColor={!isActive}> {L.fit(L.stepRight(t, i === nextIndex, now), L.RIGHT_COLUMN)}</Text>
            </Box>
          )
        })}
        {isFull && c.tasks.length > 0 && <Text>Progress {done} of {c.tasks.length}  {L.progressBar(done, c.tasks.length)}</Text>}
        {isFull && m === 'focus' && f.count > 0 && (
          <Box flexDirection="row" justifyContent="space-between">
            <Text dimColor wrap="truncate-end">{L.fit(L.foldedLine(f), Math.max(8, cols - 10))}</Text>
            <Button key="show" label={unfolded ? 'hide' : 'show'} onPress={() => update($, isUnfolded, v => !v)} />
          </Box>
        )}
      </Box>
    )
  }).catch(async ($, e, next) => (await noteError($, ctx, 'AbovePrompt', next.error), next(e)))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    ctx.drawn.add('Pane')
    const view = { mode: await read($, mode), checklist: await read($, checklist), history: await read($, history), now: await read($, clockNow) }
    return drawPane($, e, view)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'Pane', next.error), next(e)))

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    ctx.drawn.add('ToolUse')
    const d = await rowDecision($, ctx, e.props ?? {})
    if (d === 'hide') return hidden(e, $)
    if (d === 'before-edit') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>  read {L.basename(L.toolPath(e.props?.input) ?? '')} before editing</Text>
    }
    return next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ToolUse', next.error), next(e)))

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    ctx.drawn.add('ToolResult')
    const p = e.props ?? {}
    const d = await rowDecision($, ctx, p)
    if (d === 'hide' || d === 'before-edit') return hidden(e, $)
    const isQuietBash = p.tool === 'Bash' && !p.isErrored && !p.isExpanded && (await read($, mode)) === 'focus' && !(await read($, isUnfolded))
    return isQuietBash ? hidden(e, $) : next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ToolResult', next.error), next(e)))

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    ctx.drawn.add('ToolGroup')
    const m = await read($, mode)
    const p = e.props
    if (m === 'calm' && !p?.isExpanded) return hidden(e, $)
    if (m !== 'focus' || p?.isExpanded) return next(e)
    if (await read($, isUnfolded)) return next({ ...e, props: { ...p, isExpanded: true } })
    const f = await read($, folded)
    const decisions = (Array.isArray(p?.calls) ? p.calls : []).map(call =>
      L.foldDecision(call, { roots: ctx.roots, isBeforeEdit: isBeforeEdit(f.beforeEdit, call.tool_use_id) }))
    if (decisions.every(d => d === 'fold')) return hidden(e, $)
    // Something in the group must stay visible: unfold it, and the ToolUse hook folds the rest.
    return next({ ...e, props: { ...p, isExpanded: true } })
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ToolGroup', next.error), next(e)))

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    ctx.drawn.add('ToolProgress')
    return (await read($, mode)) === 'calm' ? next({ ...e, props: { ...e.props, hint: '' } }) : next(e)
  }).catch(async ($, e, next) => (await noteError($, ctx, 'ToolProgress', next.error), next(e)))
}

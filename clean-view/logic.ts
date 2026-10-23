import type { Checklist, Folded, JobOutcome, JobRecord, Mode, Phase, Task, TaskStatus, Touched } from './types'

// Pure logic for Clean View: no `$`, so every function here is unit tested.

export const MODES: readonly Mode[] = ['focus', 'band', 'calm', 'off']
export const isMode = (s: string): s is Mode => (MODES as readonly string[]).includes(s)
export const nextMode = (m: Mode): Mode => MODES[(MODES.indexOf(m) + 1) % MODES.length] ?? 'focus'
export function isNewerVersion(version: string, tested: string): boolean {
  const parts = (v: string) => v.split(/[.-]/).slice(0, 3).map(n => Number(n) || 0)
  const [a, b] = [parts(version), parts(tested)]
  const i = a.findIndex((n, k) => n !== b[k])
  return i >= 0 && (a[i] ?? 0) > (b[i] ?? 0)
}

export const modeLabel = (m: Mode) => m.charAt(0).toUpperCase() + m.slice(1)

export const MODE_HELP: Readonly<Record<Mode, string>> = {
  focus: 'band on; reads and searches folded; diffs, commands and failures shown',
  band: 'band on; every tool row shown',
  calm: 'band on; all tool rows hidden',
  off: 'band hidden except the mode button',
}
export const helpText = () => MODES.map(m => `${m}: ${MODE_HELP[m]}`).join('\n')

// ── Names ───────────────────────────────────────────────────────────────────

const isShortPair = (t: string) => /^[a-z]{1,3}\/[a-z]{1,3}$/i.test(t) // and/or, I/O

function trimTo(s: string, max: number): string {
  if (s.length <= max) return s
  const cut = s.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '') + '…'
}

export function cleanName(raw: unknown, max = 50): string {
  const s = (typeof raw === 'string' ? raw : '')
    .replace(/`([^`]*)`/g, (_, inner: string) => (inner.length > 20 || inner.includes('/') ? ' ' : inner))
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .split(/\s+/)
    .filter(t => !t.includes('/') || isShortPair(t))
    .join(' ')
    .replace(/\s+(in|to|for|from|of|on|at|with|into|under)$/i, '')
    .trim()
  return s ? trimTo(s.charAt(0).toUpperCase() + s.slice(1), max) : 'Working on it'
}

export const firstWords = (text: string, n = 6) => cleanName(text.trim().split(/\s+/).slice(0, n).join(' '))

export function planSteps(plan: string): string[] {
  const grab = (re: RegExp) => plan.split('\n').flatMap(l => re.exec(l)?.[1] ?? [])
  const numbered = grab(/^\s?\d+[.)]\s+(.+)/)
  const bullets = grab(/^[-*]\s+(.+)/)
  const headings = grab(/^#{2,3}\s+(.+)/).filter(h => !/context|verification|overview|summary/i.test(h))
  const pick = numbered.length >= 2 ? numbered : bullets.length >= 2 ? bullets : headings
  return pick.slice(0, 8).map(s => cleanName(s.replace(/:.*$/, '')))
}

// ── Checklist reducer ───────────────────────────────────────────────────────

export const emptyChecklist = (): Checklist => ({
  title: '', phase: 'idle', tasks: [], needsYouReason: null, stuckReason: null,
  errorText: null, errorType: null, startedAt: null, finishedAt: null,
  isCollapsed: false, toolCalls: 0, failStreak: 0, lastCall: null,
})

export const emptyTouched = (): Touched => ({ read: [], edited: [], searches: [] })
export const newTask = (id: string, name: string): Task =>
  ({ id, name, status: 'upcoming', startedAt: null, endedAt: null, toolCalls: 0, failures: 0, touched: emptyTouched() })

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])

// State saved by an older version lacks newer fields: fill them so nothing reads undefined.
export function normalizeTask(t: Partial<Task>): Task {
  const touched = (t.touched ?? {}) as Partial<Touched>
  return {
    ...newTask(String(t.id ?? ''), String(t.name ?? '')), ...t,
    endedAt: t.endedAt ?? null, failures: t.failures ?? 0,
    touched: { read: strings(touched.read), edited: strings(touched.edited), searches: strings(touched.searches) },
  }
}
export function normalizeChecklist(c: Partial<Checklist> | null | undefined): Checklist {
  const base = { ...emptyChecklist(), ...c }
  return { ...base, lastCall: base.lastCall ?? null, tasks: Array.isArray(base.tasks) ? base.tasks.map(normalizeTask) : [] }
}

export type ChecklistEvent =
  | { type: 'job'; text: string; now: number }
  | { type: 'planning' }
  | { type: 'tool.start'; tool?: string; input?: unknown; now?: number }
  | { type: 'tool.end'; isError: boolean; isDenied: boolean }
  | { type: 'task.create'; id: string; name: string }
  | { type: 'task.update'; id: string; status?: string; name?: string; now: number }
  | { type: 'todos'; todos: ReadonlyArray<{ content?: unknown; status?: unknown }>; now: number }
  | { type: 'plan'; text: string; now: number }
  | { type: 'needs-you'; reason: string }
  | { type: 'denied' }
  | { type: 'api-error'; errorType: string; details?: string; now: number }
  | { type: 'turn.end'; reason: string; now: number }
  | { type: 'collapse' }

const STATUS: Record<string, TaskStatus> = { completed: 'done', in_progress: 'active', pending: 'upcoming' }
const LIVE: readonly Phase[] = ['working', 'planning', 'needs-you', 'stuck']
const CONTINUES: readonly Phase[] = ['needs-you', 'stuck', 'stopped']
const DENIED = 'You said no to a step, so Claude paused'
const FAILING = 'A step keeps failing, Claude is trying another way'

export const hasUnfinished = (c: Checklist) => c.tasks.some(t => t.status !== 'done')
export const isTicking = (c: Checklist) => LIVE.includes(c.phase)
export const isVisible = (c: Checklist) =>
  c.phase !== 'idle' && (c.tasks.length > 0 || c.toolCalls > 0 || c.phase === 'error' || c.phase === 'planning')

const resume = (c: Checklist): Checklist =>
  c.phase === 'needs-you' || c.phase === 'stuck' ? { ...c, phase: 'working', needsYouReason: null, stuckReason: null } : c

const start = (t: Task, status: TaskStatus, now: number): Task => ({
  ...t,
  status,
  startedAt: status === 'active' ? (t.startedAt ?? now) : t.startedAt,
  endedAt: status === 'done' ? (t.endedAt ?? (t.startedAt === null ? null : now)) : status === 'active' ? null : t.endedAt,
})

export function reduce(saved: Checklist, ev: ChecklistEvent): Checklist {
  let c = normalizeChecklist(saved)
  const live = c.phase !== 'idle'
  switch (ev.type) {
    case 'job':
      if (CONTINUES.includes(c.phase) && hasUnfinished(c)) return { ...c, phase: 'working', needsYouReason: null, stuckReason: null, failStreak: 0, finishedAt: null }
      return { ...emptyChecklist(), title: firstWords(ev.text), phase: 'working', startedAt: ev.now }
    case 'planning':
      return live ? { ...c, phase: 'planning' } : c
    case 'tool.start': {
      if (!live) return c
      const tool = ev.tool
      const tasks = c.tasks.map(t => (t.status !== 'active' ? t
        : { ...t, toolCalls: t.toolCalls + 1, touched: tool ? touch(t.touched, tool, ev.input) : t.touched }))
      const lastCall = tool ? { tool, summary: callSummary(tool, ev.input), at: ev.now ?? 0 } : c.lastCall
      return { ...c, tasks, lastCall, toolCalls: c.toolCalls + 1, ...(c.phase === 'needs-you' ? { phase: 'working', needsYouReason: null } : {}) }
    }
    case 'tool.end': {
      if (!live) return c
      if (ev.isError) c = { ...c, tasks: c.tasks.map(t => (t.status === 'active' ? { ...t, failures: t.failures + 1 } : t)) }
      if (ev.isDenied) return { ...c, phase: 'stuck', stuckReason: DENIED, needsYouReason: null, failStreak: 0 }
      if (!ev.isError) return { ...resume(c), failStreak: 0 }
      const failStreak = c.failStreak + 1
      return failStreak >= 3 ? { ...c, failStreak, phase: 'stuck', stuckReason: FAILING } : { ...c, failStreak }
    }
    case 'task.create':
      if (!live || c.tasks.some(t => t.id === ev.id)) return c
      return { ...c, tasks: [...c.tasks, newTask(ev.id, cleanName(ev.name))] }
    case 'task.update': {
      if (ev.status === 'deleted') return { ...c, tasks: c.tasks.filter(t => t.id !== ev.id) }
      const status = ev.status ? STATUS[ev.status] : undefined
      const tasks = c.tasks.map(t =>
        t.id !== ev.id ? t : start({ ...t, name: ev.name ? cleanName(ev.name) : t.name }, status ?? t.status, ev.now))
      return { ...c, tasks }
    }
    case 'todos': {
      if (!live) return c
      const tasks = ev.todos.map((todo, i): Task => {
        const name = cleanName(todo.content)
        const before = c.tasks.find(t => t.name === name)
        const base = before ?? newTask(`todo-${i}`, name)
        return start({ ...base, id: `todo-${i}` }, STATUS[String(todo.status)] ?? 'upcoming', ev.now)
      })
      return { ...c, tasks }
    }
    case 'plan': {
      if (!live) return c
      const tasks = c.tasks.length > 0 ? c.tasks : planSteps(ev.text).map((name, i) => newTask(`plan-${i}`, name))
      return { ...c, tasks, phase: 'working' }
    }
    case 'needs-you':
      return live ? { ...c, phase: 'needs-you', needsYouReason: cleanName(ev.reason, 60) } : c
    case 'denied':
      return live ? { ...c, phase: 'stuck', stuckReason: DENIED, needsYouReason: null } : c
    case 'api-error':
      return { ...c, phase: 'error', errorType: ev.errorType, errorText: apiErrorMessage(ev.errorType, ev.details), finishedAt: ev.now, startedAt: c.startedAt ?? ev.now }
    case 'turn.end': {
      if (!live) return c
      const ended = { ...c, finishedAt: ev.now }
      if (ev.reason === 'aborted') return { ...ended, phase: 'stopped' }
      if (ev.reason === 'refusal') return { ...ended, phase: 'error', errorType: 'refusal', errorText: "Claude couldn't help with that request" }
      if (ev.reason === 'error') return c.phase === 'error' ? ended : { ...ended, phase: 'error', errorType: 'unknown', errorText: apiErrorMessage('unknown') }
      if (c.phase === 'stuck' || c.phase === 'error') return ended
      if (hasUnfinished(c)) return { ...ended, phase: 'needs-you', needsYouReason: 'Claude is waiting for your reply' }
      return { ...ended, phase: 'done' }
    }
    case 'collapse':
      return c.phase === 'done' ? { ...c, isCollapsed: true } : c
  }
}

// ── API errors ──────────────────────────────────────────────────────────────

export function apiErrorMessage(type: string, details = ''): string {
  const d = details.toLowerCase()
  if (type === 'rate_limit' || type === 'billing_error') return 'Usage limit reached, try again later'
  if (type === 'overloaded' || type === 'server_error') return 'Servers busy, try again in a minute'
  if (/auth|oauth|credential|account_on_hold|verification/.test(type)) return 'Signed out, run /login'
  if (/too long|context window|context length|prompt is too/.test(d)) return 'Context too long, run /compact and retry'
  if (/network|econn|socket|fetch failed|timed? ?out|connection/.test(d)) return 'Connection dropped'
  return 'Claude hit an error'
}

// ── Folding ─────────────────────────────────────────────────────────────────

export const FOLDABLE: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'ToolSearch', 'WebSearch', 'WebFetch', 'TaskCreate', 'TaskUpdate', 'TodoWrite',
])
export const EDITS: ReadonlySet<string> = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

export const field = (input: unknown, key: string): string | undefined => {
  const v = input && typeof input === 'object' ? (input as Record<string, unknown>)[key] : undefined
  return typeof v === 'string' ? v : undefined
}
export const toolPath = (input: unknown) => field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path')
export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p

function normalize(p: string): string {
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return '/' + out.join('/')
}

export function isSensitive(p: string): boolean {
  const parts = p.toLowerCase().split('/')
  const base = parts[parts.length - 1] ?? ''
  return base.startsWith('.env') || parts.includes('.ssh') || base.endsWith('.pem') || /key|secret|credential/.test(base)
}

export function isOutside(p: string, roots: readonly string[]): boolean {
  if (p.startsWith('~')) return true
  if (!p.startsWith('/')) return p.split('/').includes('..')
  const path = normalize(p)
  return !roots.some(r => {
    const root = normalize(r)
    return path === root || path.startsWith(root === '/' ? '/' : root + '/')
  })
}

export type FoldCall = { tool: string; input: unknown; isErrored?: boolean }
export type FoldContext = { roots: readonly string[]; isBeforeEdit: boolean }

export function foldDecision(call: FoldCall, ctx: FoldContext): 'fold' | 'keep' | 'before-edit' {
  if (call.isErrored || !FOLDABLE.has(call.tool)) return 'keep'
  const path = toolPath(call.input)
  if (path && (isOutside(path, ctx.roots) || isSensitive(path))) return 'keep'
  const pattern = field(call.input, 'pattern')
  if (call.tool === 'Glob' && pattern && isSensitive(pattern)) return 'keep'
  if (call.tool === 'Read' && !path) return 'keep'
  return call.tool === 'Read' && ctx.isBeforeEdit ? 'before-edit' : 'fold'
}

export const emptyFolded = (): Folded => ({ files: [], searches: [], hosts: [], count: 0, beforeEdit: [], ids: [] })

export function addFolded(f: Folded, tool: string, input: unknown, id?: string): Folded {
  const path = toolPath(input)
  const search = tool === 'Glob' || tool === 'Grep' ? field(input, 'pattern') : tool === 'WebSearch' ? field(input, 'query') : undefined
  const host = tool === 'WebFetch' ? /^[a-z]+:\/\/([^/:?#]+)/i.exec(field(input, 'url') ?? '')?.[1] : undefined
  const file = (tool === 'Read' || tool === 'LS') && path ? basename(path) : undefined
  const add = (list: string[], v?: string, isUnique = true) =>
    v === undefined || (isUnique && list.includes(v)) ? list : [...list, v].slice(-50)
  const ids = id ? [...f.ids, id].slice(-200) : f.ids
  return { ...f, ids, count: f.count + 1, files: add(f.files, file), searches: add(f.searches, search, false), hosts: add(f.hosts, host) }
}

const more = (n: number) => (n > 0 ? ` +${n}` : '')

export function foldedLine(f: Folded): string {
  const parts: string[] = []
  if (f.files.length) parts.push(`read ${f.files.slice(0, 3).join(', ')}${more(f.files.length - 3)}`)
  const counts = new Map<string, number>()
  for (const s of f.searches) counts.set(s, (counts.get(s) ?? 0) + 1)
  if (counts.size) {
    const named = [...counts].slice(0, 3).map(([s, n]) => `"${trimTo(s, 24)}"${n > 1 ? ` ×${n}` : ''}`)
    parts.push(`searched ${named.join(', ')}${more(counts.size - 3)}`)
  }
  if (f.hosts.length) parts.push(`fetched ${f.hosts.slice(0, 3).join(', ')}${more(f.hosts.length - 3)}`)
  if (!parts.length) parts.push(`${f.count} lookup${f.count === 1 ? '' : 's'}`)
  return `Folded: ${parts.join(' · ')}`
}

// ── Drawing helpers ─────────────────────────────────────────────────────────

const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000))
export const stepClock = (ms: number) => `${Math.floor(seconds(ms) / 60)}:${String(seconds(ms) % 60).padStart(2, '0')}`
export const duration = (ms: number) => {
  const s = seconds(ms)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}
export const progressBar = (done: number, total: number, cells = 10) => {
  const n = total > 0 ? Math.round((done / total) * cells) : 0
  return '█'.repeat(n) + '░'.repeat(cells - n)
}
export const fit = (s: string, n: number) => (s.length <= n ? s : n <= 1 ? '…' : s.slice(0, n - 1) + '…')

export const RIGHT_COLUMN = 16
export const PANE_BUTTON_WIDTH = 9 // `[ Pane ]` and a space
export const MIN_STEP_COLUMNS = 50
export const nameColumn = (bodyColumns: number) => Math.max(8, Math.min(50, bodyColumns - 2 - RIGHT_COLUMN - 1))

export function stepRight(t: Task, isNext: boolean, now: number): string {
  if (t.status === 'done') return 'Done'
  if (t.status === 'active') return `${stepClock(now - (t.startedAt ?? now))} · ${t.toolCalls} call${t.toolCalls === 1 ? '' : 's'}`
  return isNext ? 'Next' : 'Up next'
}

export type Header = { badge: string | null; text: string; detail: string | null; tone: 'plain' | 'warning' | 'error' | 'success' }

export function header(c: Checklist, now: number): Header {
  const title = c.tasks[0]?.name ?? c.title
  const took = duration((c.finishedAt ?? now) - (c.startedAt ?? now))
  const calls = c.tasks.length ? '' : ` · ${c.toolCalls} tool call${c.toolCalls === 1 ? '' : 's'}`
  const plain = (text: string, tone: Header['tone'] = 'plain', badge: string | null = null, detail: string | null = null) =>
    ({ badge, text, detail, tone })
  switch (c.phase) {
    case 'planning': return plain(`${title} · ${took}`, 'plain', 'Planning')
    case 'needs-you': return plain(c.needsYouReason ?? 'Claude needs you', 'warning', 'Needs you')
    case 'stuck': return plain(`⚠ Stuck: ${c.stuckReason ?? ''}`, 'warning')
    case 'stopped': return plain(`■ Stopped · ${title} · you pressed Esc`)
    case 'done': return plain(`✓ All done · ${title} · took ${took}`, 'success')
    case 'error': return plain(`⚠ ${c.errorText ?? 'Claude hit an error'}`, 'error', null, c.errorType)
    default: return plain(`${title} · ${took}${calls}`)
  }
}

// ── Progress pane ───────────────────────────────────────────────────────────

const READS: ReadonlySet<string> = new Set(['Read', 'LS', 'NotebookRead'])
const searchOf = (tool: string, input: unknown) =>
  tool === 'Glob' || tool === 'Grep' ? field(input, 'pattern') : tool === 'WebSearch' ? field(input, 'query') : undefined

// What one tool call adds to its step's touched lists, as basenames and patterns.
export function touch(t: Touched, tool: string, input: unknown): Touched {
  const path = toolPath(input)
  const add = (list: string[], v: string) => (list.includes(v) ? list : [...list, v].slice(-50))
  if (EDITS.has(tool) && path) return { ...t, edited: add(t.edited, basename(path)) }
  if (READS.has(tool) && path) return { ...t, read: add(t.read, basename(path)) }
  const search = searchOf(tool, input)
  return search ? { ...t, searches: add(t.searches, search) } : t
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

export function callSummary(tool: string, input: unknown): string {
  const path = toolPath(input)
  const url = field(input, 'url')
  const host = url ? /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1] : undefined
  const text = (tool === 'Bash' ? field(input, 'command') : undefined)
    ?? (path ? basename(path) : undefined)
    ?? searchOf(tool, input) ?? host
    ?? field(input, 'subject') ?? field(input, 'description') ?? field(input, 'command') ?? ''
  return fit(oneLine(text), 60)
}

export const listWithMore = (list: readonly string[], n: number, quote = false) =>
  list.slice(0, n).map(s => (quote ? `"${trimTo(s, 24)}"` : s)).join(', ') + more(list.length - n)

// The active step's detail: edited files first, then reads not also edited.
export function touchedLines(t: Touched): { edited: string | null; read: string | null; searches: string | null } {
  const read = t.read.filter(f => !t.edited.includes(f))
  return {
    edited: t.edited.length ? `Edited ${listWithMore(t.edited, 6)}` : null,
    read: read.length ? `Read ${listWithMore(read, 6)}` : null,
    searches: t.searches.length ? `Searched ${listWithMore(t.searches, 3, true)}` : null,
  }
}

export const ago = (ms: number) => (ms < 5000 ? 'just now' : `${duration(ms)} ago`)

export function stepMs(t: Task, now: number): number {
  if (t.startedAt === null || t.status === 'upcoming') return 0
  return Math.max(0, (t.endedAt ?? (t.status === 'active' ? now : t.startedAt)) - t.startedAt)
}

// Each bar is its step's share of the time, scaled so the longest fills `width`.
export function barWidths(ms: readonly number[], width: number): number[] {
  const max = Math.max(0, ...ms)
  return ms.map(n => (max > 0 ? Math.round((n / max) * Math.max(0, width)) : 0))
}

// The active bar ends in a lighter segment: the part still growing.
export const barText = (cells: number, isActive: boolean) =>
  isActive ? '█'.repeat(Math.max(0, cells - 2)) + '▒'.repeat(Math.min(2, Math.max(1, cells))) : '█'.repeat(cells)

export type TimelineRow = {
  name: string
  status: TaskStatus
  mark: string
  cells: number
  ms: number
  time: string
  failures: number
}

export function timelineRows(c: Checklist, now: number, barWidth: number): TimelineRow[] {
  const tasks = normalizeChecklist(c).tasks
  const ms = tasks.map(t => stepMs(t, now))
  const cells = barWidths(ms, barWidth)
  return tasks.map((t, i) => {
    const isActive = t.status === 'active'
    return {
      name: t.name,
      status: t.status,
      mark: t.status === 'done' ? '✓' : isActive ? (c.phase === 'needs-you' ? '‖' : '▶') : '○',
      cells: t.status === 'upcoming' ? 0 : isActive ? Math.max(1, cells[i] ?? 0) : (cells[i] ?? 0),
      ms: ms[i] ?? 0,
      time: t.status === 'upcoming' ? '' : `${stepClock(ms[i] ?? 0)} · ${t.toolCalls} call${t.toolCalls === 1 ? '' : 's'}`,
      failures: t.failures,
    }
  })
}

export const failureText = (n: number) => (n > 0 ? `⚠ ${n} failed` : '')

// Column widths for a timeline row of `cols` cells: mark, name, bar, time, failures.
export function timelineColumns(cols: number) {
  const name = Math.max(8, Math.min(32, Math.floor(cols * 0.35)))
  const time = 15
  const fail = 11
  const bar = Math.max(0, cols - 2 - name - 1 - 1 - time - fail)
  return { name, bar: bar >= 4 ? bar : 0, time, fail }
}

// A window of at most `room` rows that keeps the active step in view.
export function windowRows<T>(rows: readonly T[], activeIndex: number, room: number): { rows: T[]; hidden: number } {
  const n = Math.max(1, room)
  if (rows.length <= n) return { rows: [...rows], hidden: 0 }
  const from = Math.max(0, Math.min(rows.length - n, (activeIndex < 0 ? 0 : activeIndex) - Math.floor(n / 2)))
  return { rows: rows.slice(from, from + n), hidden: rows.length - n }
}

export const PHASE_BADGE: Readonly<Record<Phase, string>> = {
  idle: '', working: 'Working', planning: 'Planning', 'needs-you': 'Needs you',
  stuck: 'Stuck', stopped: 'Stopped', done: 'All done', error: 'Stuck',
}

export const jobTitle = (c: Checklist) => c.tasks[0]?.name ?? (c.title || 'No job yet')
export const jobMs = (c: Checklist, now: number) => (c.startedAt === null ? 0 : Math.max(0, (c.finishedAt ?? now) - c.startedAt))

// ── History ─────────────────────────────────────────────────────────────────

export const HISTORY_CAP = 5
const OUTCOME: Partial<Record<Phase, JobOutcome>> = { done: 'done', stopped: 'stopped', stuck: 'stuck', error: 'error' }

export function jobRecord(c: Checklist): JobRecord | null {
  const outcome = OUTCOME[c.phase]
  if (!outcome || c.startedAt === null) return null
  return { title: jobTitle(c), outcome, durationMs: jobMs(c, c.finishedAt ?? c.startedAt), steps: c.tasks.length, startedAt: c.startedAt }
}

// Newest first; a job that ends again (resumed after Stop) replaces its own entry.
export const addHistory = (h: readonly JobRecord[], r: JobRecord): JobRecord[] =>
  [r, ...h.filter(x => x.startedAt !== r.startedAt)].slice(0, HISTORY_CAP)

export function normalizeHistory(v: unknown): JobRecord[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((r): JobRecord[] => {
    if (!r || typeof r !== 'object') return []
    const o = r as Partial<JobRecord>
    const outcome = o.outcome && ['done', 'stopped', 'stuck', 'error'].includes(o.outcome) ? o.outcome : 'done'
    return [{ title: String(o.title ?? 'Job'), outcome, durationMs: Number(o.durationMs) || 0, steps: Number(o.steps) || 0, startedAt: Number(o.startedAt) || 0 }]
  }).slice(0, HISTORY_CAP)
}

const OUTCOME_MARK: Readonly<Record<JobOutcome, string>> = { done: '✓', stopped: '■', stuck: '⚠', error: '⚠' }
export const historyLine = (r: JobRecord) =>
  `${OUTCOME_MARK[r.outcome]} ${r.title} · ${duration(r.durationMs)} · ${r.steps} step${r.steps === 1 ? '' : 's'}`

// ── Timeline as SVG (desktop) ───────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
export const SVG_COLORS = { done: '#3a9d5d', active: '#d97757', failed: '#d64545', track: '#8884', text: '#8a8a8a' } as const

// A Gantt-style chart: one row per step, bars on a shared time axis.
export function timelineSvg(rows: readonly TimelineRow[], width = 560): string {
  const rowH = 26
  const label = Math.round(width * 0.36)
  const right = 120
  const barW = Math.max(40, width - label - right - 16)
  const cells = barWidths(rows.map(r => (r.status === 'upcoming' ? 0 : r.ms)), barW)
  const height = rows.length * rowH + 8
  const body = rows.map((r, i) => {
    const y = 4 + i * rowH
    const mid = y + rowH / 2
    const w = r.status === 'active' ? Math.max(4, cells[i] ?? 0) : (cells[i] ?? 0)
    const x = label + 8
    const cls = r.status === 'active' ? 'a' : r.status === 'done' ? 'd' : 'u'
    const parts = [`<text class="t ${cls}" x="4" y="${mid + 4}">${esc(r.mark)} ${esc(fit(r.name, Math.floor(label / 7.5)))}</text>`]
    if (r.status === 'done' && w > 0) parts.push(`<rect x="${x}" y="${y + 6}" width="${w}" height="${rowH - 12}" rx="3" fill="${SVG_COLORS.done}" opacity=".75"/>`)
    if (r.status === 'active') {
      const tail = Math.min(w, Math.max(4, Math.round(w * 0.2)))
      parts.push(`<rect x="${x}" y="${y + 5}" width="${w - tail}" height="${rowH - 10}" rx="3" fill="${SVG_COLORS.active}"/>`)
      parts.push(`<rect x="${x + w - tail}" y="${y + 5}" width="${tail}" height="${rowH - 10}" rx="3" fill="${SVG_COLORS.active}" opacity=".4"/>`)
    }
    for (let k = 0; k < Math.min(r.failures, 20); k++) {
      const tx = x + Math.round(((k + 1) / (Math.min(r.failures, 20) + 1)) * Math.max(w, 8))
      parts.push(`<line x1="${tx}" y1="${y + 2}" x2="${tx}" y2="${y + rowH - 2}" stroke="${SVG_COLORS.failed}" stroke-width="2"/>`)
    }
    if (r.time) parts.push(`<text class="t m" x="${width - right}" y="${mid + 4}">${esc(r.time)}${r.failures ? ` <tspan fill="${SVG_COLORS.failed}">⚠ ${r.failures}</tspan>` : ''}</text>`)
    return parts.join('')
  }).join('')
  // Mid-tone fills read on light and dark: an image can't see the app's theme.
  const style = `.t{font:12px ui-sans-serif,system-ui,sans-serif;fill:${SVG_COLORS.text}}.d,.m{opacity:.75}.u{opacity:.6}`
    + `.a{font-weight:700;fill:${SVG_COLORS.active}}`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>${style}</style>`
    + `<line x1="${label + 8}" y1="2" x2="${label + 8}" y2="${height - 2}" stroke="${SVG_COLORS.track}"/>${body}</svg>`
}

export const timelineAlt = (rows: readonly TimelineRow[]) =>
  rows.map(r => [r.mark, r.name, r.time, failureText(r.failures)].filter(Boolean).join(' ')).join('\n')

import type { Checklist, Folded, Mode, Phase, Task, TaskStatus } from './types'

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
  isCollapsed: false, toolCalls: 0, failStreak: 0,
})

export type ChecklistEvent =
  | { type: 'job'; text: string; now: number }
  | { type: 'planning' }
  | { type: 'tool.start' }
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

const start = (t: Task, status: TaskStatus, now: number): Task =>
  ({ ...t, status, startedAt: status === 'active' ? (t.startedAt ?? now) : t.startedAt })

export function reduce(c: Checklist, ev: ChecklistEvent): Checklist {
  const live = c.phase !== 'idle'
  switch (ev.type) {
    case 'job':
      if (CONTINUES.includes(c.phase) && hasUnfinished(c)) return { ...c, phase: 'working', needsYouReason: null, stuckReason: null, failStreak: 0, finishedAt: null }
      return { ...emptyChecklist(), title: firstWords(ev.text), phase: 'working', startedAt: ev.now }
    case 'planning':
      return live ? { ...c, phase: 'planning' } : c
    case 'tool.start': {
      if (!live) return c
      const tasks = c.tasks.map(t => (t.status === 'active' ? { ...t, toolCalls: t.toolCalls + 1 } : t))
      return { ...c, tasks, toolCalls: c.toolCalls + 1, ...(c.phase === 'needs-you' ? { phase: 'working', needsYouReason: null } : {}) }
    }
    case 'tool.end': {
      if (!live) return c
      if (ev.isDenied) return { ...c, phase: 'stuck', stuckReason: DENIED, needsYouReason: null, failStreak: 0 }
      if (!ev.isError) return { ...resume(c), failStreak: 0 }
      const failStreak = c.failStreak + 1
      return failStreak >= 3 ? { ...c, failStreak, phase: 'stuck', stuckReason: FAILING } : { ...c, failStreak }
    }
    case 'task.create':
      if (!live || c.tasks.some(t => t.id === ev.id)) return c
      return { ...c, tasks: [...c.tasks, { id: ev.id, name: cleanName(ev.name), status: 'upcoming', startedAt: null, toolCalls: 0 }] }
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
        const base = before ?? { id: `todo-${i}`, name, status: 'upcoming', startedAt: null, toolCalls: 0 }
        return start({ ...base, id: `todo-${i}` }, STATUS[String(todo.status)] ?? 'upcoming', ev.now)
      })
      return { ...c, tasks }
    }
    case 'plan': {
      if (!live) return c
      const tasks = c.tasks.length > 0 ? c.tasks : planSteps(ev.text).map((name, i): Task =>
        ({ id: `plan-${i}`, name, status: 'upcoming', startedAt: null, toolCalls: 0 }))
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

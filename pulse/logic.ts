import type { Bucket, Job, Kind, LastCall, Phase, Pinned, Step, StepStatus } from './types'

// Pure logic for Pulse: no `$` here, so all of it is unit tested.

// Calls are kept in 250ms slots; the wave shows them in columns of BUCKET_MS,
// or of a shorter span (one of SPANS) while a short job would not fill the pane.
export const SLOT_MS = 250
export const BUCKET_MS = 5000
export const SPANS = [500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, BUCKET_MS] as const
export const RING = 120
export const HISTORY_MS = RING * BUCKET_MS
export const MAX_SLOTS = HISTORY_MS / SLOT_MS
export const MAX_FILES = 5
const MAX_NAME = 40
export const FRAME_MS = 100
// Below this many body columns the legend goes and the header shortens.
export const NARROW = 40
// Body columns left empty at the pane's right edge.
export const MARGIN = 1
export const MAX_WAVE_ROWS = 6
const STUCK_AFTER = 3

// The pane's requested width, in body columns.
export const WIDTH = { initial: 44, min: 28, max: 72, step: 8 } as const
export function clampWidth(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : WIDTH.initial
  return Math.max(WIDTH.min, Math.min(WIDTH.max, n))
}

// ── Defaults ────────────────────────────────────────────────────────────────

export const emptyJob = (): Job => ({ title: '', phase: 'idle', startedAt: null, finishedAt: null, failStreak: 0 })
export const emptyBucket = (at: number): Bucket => ({ at, read: 0, search: 0, edit: 0, run: 0, fail: 0, files: [] })

const PHASES: readonly Phase[] = ['idle', 'working', 'needs-you', 'stuck', 'done', 'stopped']
const STATUSES: readonly StepStatus[] = ['done', 'active', 'upcoming']
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const numOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, d = '') => (typeof v === 'string' ? v : d)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

export function normalizeJob(v: unknown): Job {
  const j = obj(v)
  const phase = PHASES.includes(j.phase as Phase) ? (j.phase as Phase) : 'idle'
  return { title: str(j.title), phase, startedAt: numOrNull(j.startedAt), finishedAt: numOrNull(j.finishedAt), failStreak: num(j.failStreak, 0) }
}

export function normalizeSteps(v: unknown): Step[] {
  return (Array.isArray(v) ? v : []).map((raw, i) => {
    const s = obj(raw)
    const status = STATUSES.includes(s.status as StepStatus) ? (s.status as StepStatus) : 'upcoming'
    return { id: str(s.id, `step-${i}`), name: str(s.name), status, startedAt: numOrNull(s.startedAt), endedAt: numOrNull(s.endedAt), calls: num(s.calls, 0) }
  })
}

export function normalizeBuckets(v: unknown): Bucket[] {
  return (Array.isArray(v) ? v : []).slice(-MAX_SLOTS).map(raw => {
    const b = obj(raw)
    const files = Array.isArray(b.files) ? b.files.filter((f): f is string => typeof f === 'string').slice(0, MAX_FILES).map(f => fit(f, MAX_NAME)) : []
    return { at: num(b.at, 0), read: num(b.read, 0), search: num(b.search, 0), edit: num(b.edit, 0), run: num(b.run, 0), fail: num(b.fail, 0), files }
  })
}

export function normalizePinned(v: unknown): Pinned {
  const p = obj(v)
  if (p.kind === 'column' && typeof p.at === 'number') return typeof p.span === 'number' ? { kind: 'column', at: p.at, span: p.span } : { kind: 'column', at: p.at }
  if (p.kind === 'step' && typeof p.id === 'string') return { kind: 'step', id: p.id }
  return null
}

export function normalizeLastCall(v: unknown): LastCall | null {
  const c = obj(v)
  return typeof c.tool === 'string' ? { tool: c.tool, summary: str(c.summary), at: num(c.at, 0) } : null
}

// ── Kinds and buckets ───────────────────────────────────────────────────────

const READS = new Set(['Read', 'NotebookRead', 'LS', 'WebFetch'])
const SEARCHES = new Set(['Grep', 'Glob', 'WebSearch', 'ToolSearch'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Bookkeeping calls that don't do work of their own are left off the wave.
const QUIET = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion'])

export function kindOf(tool: string): Exclude<Kind, 'fail'> | null {
  if (QUIET.has(tool)) return null
  if (READS.has(tool)) return 'read'
  if (SEARCHES.has(tool)) return 'search'
  if (EDITS.has(tool)) return 'edit'
  return 'run'
}

export const bucketAt = (t: number, span: number = BUCKET_MS) => Math.floor(t / span) * span
export const slotAt = (t: number) => bucketAt(t, SLOT_MS)
export const totalOf = (b: Bucket) => b.read + b.search + b.edit + b.run + b.fail

// Keeps the newest `cap` items.
export const pushRing = <T>(list: readonly T[], item: T, cap = RING): T[] => [...list, item].slice(-cap)

export type Call = { at: number; kind: Exclude<Kind, 'fail'>; file?: string }

// Counts one call into the slot its start time falls in; slots stay oldest first,
// and those older than the history the wave can show are dropped.
export function addCall(buckets: readonly Bucket[], call: Call): Bucket[] {
  const at = slotAt(call.at)
  const i = buckets.findIndex(b => b.at === at)
  const base = i >= 0 ? buckets[i]! : emptyBucket(at)
  const file = call.file ? fit(call.file, MAX_NAME) : undefined
  const files = file && !base.files.includes(file) ? [...base.files, file].slice(-MAX_FILES) : base.files
  const next = { ...base, [call.kind]: base[call.kind] + 1, files }
  if (i >= 0) return buckets.map((b, j) => (j === i ? next : b))
  const sorted = [...buckets, next].sort((a, b) => a.at - b.at)
  const newest = sorted[sorted.length - 1]!.at
  return sorted.filter(b => b.at > newest - HISTORY_MS).slice(-MAX_SLOTS)
}

// A call that failed moves from its kind to `fail` in the slot it started in.
export function markFailed(buckets: readonly Bucket[], startedAt: number, kind: Exclude<Kind, 'fail'>): Bucket[] {
  const at = slotAt(startedAt)
  return buckets.map(b => (b.at !== at ? b : { ...b, [kind]: Math.max(0, b[kind] - 1), fail: b.fail + 1 }))
}

const mergeBucket = (a: Bucket, b: Bucket): Bucket => ({
  at: a.at, read: a.read + b.read, search: a.search + b.search, edit: a.edit + b.edit, run: a.run + b.run, fail: a.fail + b.fail,
  files: [...a.files, ...b.files.filter(f => !a.files.includes(f))].slice(-MAX_FILES),
})

// `count` columns of `span` ms, the last holding `endAt`: the slots summed into
// each, empty columns filled in for gaps.
export function denseColumns(buckets: readonly Bucket[], endAt: number, count: number, span: number = BUCKET_MS): Bucket[] {
  const first = bucketAt(endAt, span) - (count - 1) * span
  const out = Array.from({ length: Math.max(0, count) }, (_, i) => emptyBucket(first + i * span))
  for (const b of buckets) {
    const i = Math.floor((b.at - first) / span)
    if (i >= 0 && i < out.length) out[i] = mergeBucket(out[i]!, b)
  }
  return out
}

// The one column of `span` ms starting at `at`.
export const columnAt = (buckets: readonly Bucket[], at: number, span: number) => denseColumns(buckets, at, 1, span)[0]!

// A failure always wins the colour; otherwise the most common kind, earlier kinds on a tie.
export function dominant(b: Bucket): Kind | null {
  if (b.fail > 0) return 'fail'
  const kinds = ['read', 'search', 'edit', 'run'] as const
  let best: Kind | null = null
  let most = 0
  for (const k of kinds) if (b[k] > most) { best = k; most = b[k] }
  return best
}

// Heights scaled so the tallest is `rows`; any call shows at least 1, none shows 0.
export function columnHeights(counts: readonly number[], rows: number): number[] {
  const max = Math.max(0, ...counts)
  return counts.map(n => (n <= 0 || max === 0 ? 0 : Math.max(1, Math.round((n / max) * rows))))
}

export function callsPerMinute(buckets: readonly Bucket[], now: number): number {
  return buckets.filter(b => b.at > now - 60_000 && b.at <= now).reduce((n, b) => n + totalOf(b), 0)
}

// ── Braille ─────────────────────────────────────────────────────────────────

// Dot bits of one braille cell, bottom row first, for its left and right columns.
const LEFT = [0x40, 0x04, 0x02, 0x01]
const RIGHT = [0x80, 0x20, 0x10, 0x08]

// The braille cell for row `row` (0 at the top) of `rows`, given the heights in dots
// of its left and right dot columns. An empty cell is the blank braille pattern.
export function brailleCell(left: number, right: number, row: number, rows: number): string {
  const floor = (rows - 1 - row) * 4
  const lit = (h: number) => Math.max(0, Math.min(4, Math.round(h) - floor))
  let bits = 0
  for (let i = 0; i < lit(left); i++) bits |= LEFT[i]!
  for (let i = 0; i < lit(right); i++) bits |= RIGHT[i]!
  return String.fromCharCode(0x2800 + bits)
}

export const BLANK = '⠀'

// ── Steps ───────────────────────────────────────────────────────────────────

export function stepMs(s: Step, now: number): number {
  if (s.startedAt === null || s.status === 'upcoming') return 0
  return Math.max(0, (s.endedAt ?? now) - s.startedAt)
}

// Whole cells for each weight, adding up to `width` exactly (largest remainder).
export function apportion(weights: readonly number[], width: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (weights.length === 0 || width <= 0) return weights.map(() => 0)
  const exact = weights.map(w => (sum > 0 ? (w / sum) * width : width / weights.length))
  const cells = exact.map(Math.floor)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r || a.i - b.i)
  for (let k = 0, left = width - cells.reduce((a, b) => a + b, 0); left > 0; k++, left--) cells[order[k % order.length]!.i]!++
  // Every step keeps a cell when there is room, taken from the widest.
  if (width >= weights.length) {
    for (let i = 0; i < cells.length; i++) {
      if (cells[i]! > 0) continue
      const widest = cells.indexOf(Math.max(...cells))
      cells[widest]!--
      cells[i] = 1
    }
  }
  return cells
}

// Each step's width is its share of the time so far; upcoming steps borrow the average.
export function stepWidths(steps: readonly Step[], now: number, width: number): number[] {
  const ms = steps.map(s => stepMs(s, now))
  const spent = ms.filter((m, i) => steps[i]!.status !== 'upcoming' && m > 0)
  const guess = spent.length ? spent.reduce((a, b) => a + b, 0) / spent.length : 1
  return apportion(steps.map((s, i) => (s.status === 'upcoming' ? guess : ms[i]!)), width)
}

export const STEP_CHAR: Readonly<Record<StepStatus, string>> = { done: '█', active: '▓', upcoming: '░' }

// ── The job ─────────────────────────────────────────────────────────────────

export type Model = { job: Job; steps: Step[] }

export type JobEvent =
  | { type: 'job'; text: string; now: number }
  | { type: 'tool.start'; now: number }
  | { type: 'tool.end'; isError: boolean }
  | { type: 'needs-you' }
  | { type: 'error' }
  | { type: 'task.create'; id: string; name: string }
  | { type: 'task.update'; id: string; status?: string; name?: string; now: number }
  | { type: 'todos'; todos: readonly unknown[]; now: number }
  | { type: 'plan'; text: string; now: number }
  | { type: 'turn.end'; isAborted: boolean; now: number }

const STATUS: Readonly<Record<string, StepStatus>> = { pending: 'upcoming', in_progress: 'active', completed: 'done' }
export const isLive = (p: Phase) => p === 'working' || p === 'needs-you' || p === 'stuck'

export function cleanName(raw: unknown, max = 50): string {
  const s = String(raw ?? '').replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim()
  return fit(s, max)
}
export const firstWords = (text: string, n = 6) => cleanName(text.trim().split(/\s+/).slice(0, n).join(' '))

export function planSteps(plan: string): string[] {
  const grab = (re: RegExp) => plan.split('\n').flatMap(l => re.exec(l)?.[1] ?? [])
  const numbered = grab(/^\s?\d+[.)]\s+(.+)/)
  const bullets = grab(/^[-*]\s+(.+)/)
  const pick = numbered.length >= 2 ? numbered : bullets
  return pick.slice(0, 8).map(s => cleanName(s.replace(/:.*$/, '')))
}

const newStep = (id: string, name: string): Step => ({ id, name: cleanName(name), status: 'upcoming', startedAt: null, endedAt: null, calls: 0 })

// Moves a step to `status`, stamping when it started and ended.
function setStatus(s: Step, status: StepStatus, now: number): Step {
  if (status === 'active') return { ...s, status, startedAt: s.startedAt ?? now, endedAt: null }
  if (status === 'done') return { ...s, status, startedAt: s.startedAt ?? now, endedAt: s.endedAt ?? now }
  return { ...s, status }
}

export function reduce(m: Model, ev: JobEvent): Model {
  const { job, steps } = m
  const live = isLive(job.phase)
  switch (ev.type) {
    case 'job': {
      // A follow-up prompt keeps a job whose steps aren't finished; anything else starts afresh.
      const isContinued = job.startedAt !== null && (live || steps.some(s => s.status !== 'done'))
      if (isContinued) return { steps, job: { ...job, phase: 'working', finishedAt: null, failStreak: 0 } }
      return { steps: [], job: { title: firstWords(ev.text) || 'Untitled job', phase: 'working', startedAt: ev.now, finishedAt: null, failStreak: 0 } }
    }
    case 'tool.start':
      return {
        job: job.phase === 'needs-you' ? { ...job, phase: 'working' } : job,
        steps: steps.map(s => (s.status === 'active' ? { ...s, calls: s.calls + 1 } : s)),
      }
    case 'tool.end': {
      if (!live) return m
      const failStreak = ev.isError ? job.failStreak + 1 : 0
      const phase = failStreak >= STUCK_AFTER ? 'stuck' : job.phase === 'stuck' ? 'working' : job.phase
      return { steps, job: { ...job, failStreak, phase } }
    }
    case 'needs-you':
      return live ? { steps, job: { ...job, phase: 'needs-you' } } : m
    case 'error':
      return live ? { steps, job: { ...job, phase: 'stuck' } } : m
    case 'task.create':
      return { job, steps: [...steps, newStep(ev.id, ev.name)] }
    case 'task.update': {
      if (ev.status === 'deleted') return { job, steps: steps.filter(s => s.id !== ev.id) }
      const status = ev.status ? STATUS[ev.status] : undefined
      return {
        job,
        steps: steps.map(s => (s.id !== ev.id ? s : setStatus({ ...s, name: ev.name ? cleanName(ev.name) : s.name }, status ?? s.status, ev.now))),
      }
    }
    case 'todos':
      return {
        job,
        steps: ev.todos.map((raw, i) => {
          const todo = obj(raw)
          const name = cleanName(todo.content)
          const before = steps.find(s => s.name === name)
          return setStatus({ ...(before ?? newStep(`todo-${i}`, name)), id: `todo-${i}` }, STATUS[str(todo.status)] ?? 'upcoming', ev.now)
        }),
      }
    case 'plan':
      return steps.length > 0 ? m : { job, steps: planSteps(ev.text).map((name, i) => newStep(`plan-${i}`, name)) }
    case 'turn.end':
      if (job.startedAt === null || !live) return m
      return {
        job: { ...job, phase: ev.isAborted ? 'stopped' : 'done', finishedAt: ev.now },
        steps: steps.map(s => (s.status === 'active' ? { ...s, endedAt: ev.now } : s)),
      }
  }
}

// The clock the job reads: it stops when the job finishes.
export const jobNow = (job: Job, now: number) => job.finishedAt ?? now
export const jobMs = (job: Job, now: number) => (job.startedAt === null ? 0 : Math.max(0, jobNow(job, now) - job.startedAt))

// ── Words ───────────────────────────────────────────────────────────────────

export const fit = (s: string, n: number) => (s.length <= n ? s : n <= 1 ? '…' : s.slice(0, n - 1) + '…')
const secs = (ms: number) => Math.max(0, Math.floor(ms / 1000))
export const duration = (ms: number) => {
  const s = secs(ms)
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
export const clock = (ms: number) => `${Math.floor(secs(ms) / 60)}:${String(secs(ms) % 60).padStart(2, '0')}`
export const ago = (ms: number) => (ms < 5000 ? 'just now' : `${clock(ms)} ago`)
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const field = (input: unknown, key: string): string | undefined => {
  const v = obj(input)[key]
  return typeof v === 'string' && v ? v : undefined
}
export const toolPath = (input: unknown) => field(input, 'file_path') ?? field(input, 'notebook_path') ?? field(input, 'path')
export const basename = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
const lines = (s: string | undefined) => (s ? s.split('\n').length : 0)

// `(+12 −4)` for an edit, from the text it puts in and takes out.
export function diffStat(tool: string, input: unknown): string {
  if (tool === 'Edit') return `(+${lines(field(input, 'new_string'))} −${lines(field(input, 'old_string'))})`
  if (tool === 'Write') return `(+${lines(field(input, 'content'))})`
  return ''
}

export function callSummary(tool: string, input: unknown): string {
  const path = toolPath(input)
  const url = field(input, 'url')
  const host = url ? /^[a-z]+:\/\/([^/:?#]+)/i.exec(url)?.[1] : undefined
  const text = (tool === 'Bash' ? field(input, 'command') : undefined)
    ?? (path ? basename(path) : undefined)
    ?? field(input, 'pattern') ?? field(input, 'query') ?? host
    ?? field(input, 'description') ?? ''
  const stat = diffStat(tool, input)
  return fit(text.replace(/\s+/g, ' ').trim(), 60) + (stat ? `  ${stat}` : '')
}

export const PHASE_LABEL: Readonly<Record<Phase, string>> = {
  idle: 'idle', working: 'working', 'needs-you': 'needs you', stuck: 'stuck', done: 'done', stopped: 'stopped',
}

export type Tone = 'claude' | 'warning' | 'error' | 'success' | 'subtle'
export const PHASE_TONE: Readonly<Record<Phase, Tone>> = {
  idle: 'subtle', working: 'claude', 'needs-you': 'warning', stuck: 'error', done: 'success', stopped: 'subtle',
}

export const KIND_COLOR: Readonly<Record<Kind, string>> = { read: 'suggestion', search: 'ide', edit: 'success', run: 'warning', fail: 'error' }
export const KINDS: readonly Kind[] = ['read', 'search', 'edit', 'run', 'fail']

// The colour key reads `■ read ■ search ■ edit ■ run ■ fail`.
export const LEGEND_WIDTH = KINDS.reduce((n, k) => n + `■ ${k}`.length, KINDS.length - 1)

// The rate beside the colour key, as long as `columns` leaves room for, or none.
export function legendRate(columns: number, perMin: number): string {
  return [`↻ ${perMin} calls/min`, `↻ ${perMin}/min`, `${perMin}/min`].find(r => LEGEND_WIDTH + 1 + r.length <= columns) ?? ''
}

// The width buttons at the header's right: `[−] [+]`.
export const CONTROLS = { narrower: '[−]', wider: '[+]' } as const
export const CONTROLS_WIDTH = CONTROLS.narrower.length + 1 + CONTROLS.wider.length

// The header either side of the status dot, fitted to `columns` beside the
// width buttons. Narrow, it is the dot, the elapsed time and a trimmed job name.
export function headerText(head: { title: string; elapsed: string; label: string }, columns: number): { lead: string; tail: string } {
  const room = columns - CONTROLS_WIDTH - 1
  if (columns >= NARROW - MARGIN) {
    const elapsed = head.elapsed ? ` · ${head.elapsed}` : ''
    const tail = ` ${head.label}`
    const fixed = 'Pulse · '.length + elapsed.length + ' · '.length + 1 + tail.length
    if (room - fixed >= 4) return { lead: `Pulse · ${fit(head.title, room - fixed)}${elapsed} · `, tail }
  }
  const time = head.elapsed ? ` ${head.elapsed}` : ''
  const sep = time ? ' · ' : ' '
  const nameRoom = room - 1 - time.length - sep.length
  return { lead: '', tail: nameRoom >= 2 ? `${time}${sep}${fit(head.title, nameRoom)}` : time }
}

export function headerParts(job: Job, now: number): { title: string; elapsed: string; label: string } {
  return {
    title: job.startedAt === null ? 'No job yet' : job.title || 'Untitled job',
    elapsed: job.startedAt === null ? '' : duration(jobMs(job, now)),
    label: PHASE_LABEL[job.phase],
  }
}

export function columnDetail(b: Bucket, now: number): string {
  const n = totalOf(b)
  const when = ago(Math.max(0, now - b.at))
  if (n === 0) return `${when} · no calls`
  const kinds = KINDS.filter(k => b[k] > 0).map(k => `${b[k]} ${k === 'fail' ? 'failed' : k}`).join(', ')
  return `${when} · ${plural(n, 'call')} · ${kinds}${b.files.length ? ` · ${b.files.join(', ')}` : ''}`
}

export function stepDetail(s: Step, index: number, count: number, now: number): string {
  const time = s.status === 'upcoming' ? 'not started' : duration(stepMs(s, now))
  return `step ${index + 1} of ${count} · ${s.name} · ${time} · ${plural(s.calls, 'call')}`
}

export const lastCallDetail = (c: LastCall | null, now: number) =>
  c ? `${ago(Math.max(0, now - c.at))}  ${c.tool}  ${c.summary}` : 'no calls yet'

export function stepLabel(steps: readonly Step[]): string {
  if (steps.length === 0) return ''
  const active = steps.findIndex(s => s.status === 'active')
  const done = steps.filter(s => s.status === 'done').length
  return active >= 0 ? `step ${active + 1} of ${steps.length}` : `${done} of ${steps.length} done`
}

// ── The text summary (VS Code, and the fallback when the graph fails) ───────

export type Summary = { job: Job; steps: readonly Step[]; buckets: readonly Bucket[]; last: LastCall | null; now: number }

export function textSummary(v: Summary): string[] {
  const head = headerParts(v.job, v.now)
  const t = jobNow(v.job, v.now)
  const mine = v.buckets.filter(b => v.job.startedAt !== null && b.at >= slotAt(v.job.startedAt))
  const sum = (k: Kind) => mine.reduce((n, b) => n + b[k], 0)
  const total = KINDS.reduce((n, k) => n + sum(k), 0)
  const kinds = KINDS.filter(k => sum(k) > 0).map(k => `${sum(k)} ${k === 'fail' ? 'failed' : k}`).join(', ')
  const steps = v.steps.map(s => `${s.status === 'done' ? '✓' : s.status === 'active' ? '▶' : '○'} ${s.name}${s.status === 'upcoming' ? '' : ` (${duration(stepMs(s, t))})`}`)
  return [
    `Pulse · ${head.title}${head.elapsed ? ` · ${head.elapsed}` : ''} · ● ${head.label}`,
    ...(steps.length ? [stepLabel(v.steps), ...steps] : []),
    `${plural(total, 'call')}${kinds ? `: ${kinds}` : ''} · ${callsPerMinute(v.buckets, t)} calls/min`,
    `Last: ${lastCallDetail(v.last, v.now)}`,
  ]
}

// ── The graph's frame (graph.tsx's local state) ─────────────────────────────

export type GraphProps = {
  job: Job
  steps: Step[]
  buckets: Bucket[]
  pinned: Pinned
  last: LastCall | null
  now: number
  // The region the hooks module sized the Client to: the graph never draws past it.
  columns: number
  rows: number
  // Off, the graph sets no pointer listener; the keyboard still works.
  mouse: boolean
  // On, the detail line shows the last pointer position and what it mapped to.
  debug: boolean
}

export type Hover = { kind: 'column'; at: number; span?: number } | { kind: 'step'; id: string } | null

export type Frame = {
  props: GraphProps
  // Frames since these props arrived: the client's clock runs on from `props.now`.
  since: number
  tick: number
  // Eased heights in dots, by bucket start.
  shown: Record<string, number>
  hover: Hover
  selected: number | null
  // The step bar's closing fill, 0 to 1, once the job is done.
  fill: number | null
  // The column span the heights were eased at; a new span snaps them.
  span: number | null
  // The last pointer event, for the mouse debug view.
  probe: Probe | null
}

export const frameNow = (f: Frame) => f.props.now + f.since * FRAME_MS
export const isAnimated = (p: Phase) => isLive(p)

export type Layout = {
  columns: number
  waveRows: number
  visible: number
  offset: number
  hasLegend: boolean
  rows: { header: number; wave: number; steps: number; legend: number; rule: number; detail: number }
  barWidth: number
  // The region's rows, for telling a pointer event outside it.
  height: number
  // The rows the graph draws, one line each.
  total: number
}

// Fits the graph's rows to the region: the wave takes what the other rows leave.
// `columns` already leaves the pane's right margin, so the legend goes below NARROW body columns.
export function layout(columns: number, rows: number, stepCount: number): Layout {
  const cols = Math.max(10, columns)
  const hasLegend = cols >= NARROW - MARGIN
  const fixed = 4 + (hasLegend ? 1 : 0)
  const waveRows = Math.max(1, Math.min(MAX_WAVE_ROWS, rows - fixed))
  const visible = Math.min(cols, RING)
  const label = stepCount > 0 ? `  step ${stepCount} of ${stepCount}`.length : 0
  const wave = 1
  const steps = wave + waveRows
  const legend = steps + 1
  const rule = hasLegend ? legend + 1 : legend
  return {
    columns: cols, waveRows, visible, offset: cols - visible, hasLegend,
    rows: { header: 0, wave, steps, legend: hasLegend ? legend : -1, rule, detail: rule + 1 },
    barWidth: Math.max(4, cols - label),
    height: Math.max(1, rows),
    total: rule + 2,
  }
}

// The Client's height for a region `columns` wide with `rows` to spare: exactly the rows the graph draws.
export const graphHeight = (columns: number, rows: number) => layout(columns, rows, 0).total

// The shortest span that fits the whole job in `count` columns; BUCKET_MS once
// the job has as many 5-second buckets as columns, or with no job.
export function columnSpan(job: Job, now: number, count: number): number {
  const start = job.startedAt
  if (start === null) return BUCKET_MS
  const end = jobNow(job, now)
  return SPANS.find(span => bucketAt(end, span) - bucketAt(start, span) < count * span) ?? BUCKET_MS
}

// The wave's columns: their span, and the time the last one holds. A stretched
// job stays put once it finishes; at BUCKET_MS the wave runs on with the clock.
export function columnWindow(f: Frame, l: Layout): { span: number; endAt: number } {
  const now = frameNow(f)
  const span = columnSpan(f.props.job, now, l.visible)
  return { span, endAt: span < BUCKET_MS ? jobNow(f.props.job, now) : now }
}

export function visibleColumns(f: Frame, l: Layout): Bucket[] {
  const w = columnWindow(f, l)
  return denseColumns(f.props.buckets, w.endAt, l.visible, w.span)
}

// Where each step's segment of the bar starts and ends, in cells.
export function stepRanges(steps: readonly Step[], now: number, width: number): { id: string; from: number; to: number }[] {
  const widths = stepWidths(steps, now, width)
  let x = 0
  return steps.map((s, i) => {
    const from = x
    x += widths[i]!
    return { id: s.id, from, to: x }
  })
}

export function hitTest(f: Frame, l: Layout, x: number, y: number): Hover {
  if (y >= l.rows.wave && y < l.rows.wave + l.waveRows) {
    const i = x - l.offset
    const cols = visibleColumns(f, l)
    return i >= 0 && i < cols.length ? { kind: 'column', at: cols[i]!.at, span: columnWindow(f, l).span } : null
  }
  if (y === l.rows.steps && f.props.steps.length) {
    const hit = stepRanges(f.props.steps, jobNow(f.props.job, frameNow(f)), l.barWidth).find(r => x >= r.from && x < r.to)
    return hit ? { kind: 'step', id: hit.id } : null
  }
  return null
}

export const sameHover = (a: Hover | Pinned, b: Hover | Pinned) => JSON.stringify(a) === JSON.stringify(b)

// Which width button sits under a header cell, if any.
export function controlAt(l: Layout, x: number, y: number): 'narrower' | 'wider' | null {
  if (y !== l.rows.header) return null
  const from = l.columns - CONTROLS_WIDTH
  if (x >= from && x < from + CONTROLS.narrower.length) return 'narrower'
  if (x >= l.columns - CONTROLS.wider.length && x < l.columns) return 'wider'
  return null
}

// What is drawn under a cell, by name: what the mouse debug view shows and the tests check.
export function targetAt(f: Frame, l: Layout, x: number, y: number): string {
  if (x < 0 || y < 0 || x >= l.columns || y >= l.total) return 'outside'
  const control = controlAt(l, x, y)
  if (control) return CONTROLS[control]
  if (y === l.rows.header) return 'header'
  if (y >= l.rows.wave && y < l.rows.wave + l.waveRows) return `wave ${y - l.rows.wave} col ${x - l.offset}`
  if (y === l.rows.steps) {
    const hit = hitTest(f, l, x, y)
    return hit?.kind === 'step' ? `step ${hit.id}` : 'steps'
  }
  if (y === l.rows.legend) return 'legend'
  if (y === l.rows.rule) return 'rule'
  return y === l.rows.detail ? 'detail' : 'outside'
}

export type Probe = { x: number; y: number; target: string }

export type PointerInput ={ type: 'down' | 'move' | 'up' | 'enter' | 'leave'; x: number; y: number; button?: 'left' | 'middle' | 'right' }
export type PointerOutcome = { hover: Hover; pin?: Hover; resize?: -1 | 1; release: boolean }

// One pointer event. A click acts on 'down' and lets the pointer go at once, so
// later moves are hovers, never a drag. Leaving, or any event outside the
// region, clears hover and lets go too.
export function pointerOutcome(f: Frame, l: Layout, e: PointerInput): PointerOutcome {
  const isOutside = e.x < 0 || e.y < 0 || e.x >= l.columns || e.y >= l.height
  if (e.type === 'leave' || isOutside) return { hover: null, release: true }
  if (e.type === 'down') {
    if (e.button !== 'left') return { hover: f.hover, release: true }
    const control = controlAt(l, e.x, e.y)
    if (control) return { hover: null, resize: control === 'wider' ? 1 : -1, release: true }
    const hit = hitTest(f, l, e.x, e.y)
    return hit ? { hover: hit, pin: hit, release: true } : { hover: hit, release: true }
  }
  if (e.type === 'up') return { hover: f.hover, release: false }
  return { hover: hitTest(f, l, e.x, e.y), release: false }
}

// Holds the graph's pointer listener: set while the mouse is on, gone while off.
export type PointerSlot = { clear: (() => void) | null }

export function syncPointer<F>(onPointer: (fn: F) => () => void, slot: PointerSlot, isOn: boolean, fn: F) {
  if (isOn && !slot.clear) slot.clear = onPointer(fn)
  else if (!isOn) releasePointer(slot)
}

// Drops the listener, and with it any hold a 'down' left; the next draw sets it again.
export function releasePointer(slot: PointerSlot) {
  slot.clear?.()
  slot.clear = null
}

// The detail line: pinned first, then hover, then the keyboard's column, else the latest call.
export function detailLine(f: Frame, l: Layout): { text: string; isPinned: boolean } {
  const now = frameNow(f)
  const { steps, pinned, last, buckets } = f.props
  if (f.props.debug) return { text: f.probe ? `mouse ${f.probe.x},${f.probe.y} → ${f.probe.target}` : 'mouse: no pointer yet', isPinned: false }
  const describe = (h: Hover): string | null => {
    if (h?.kind === 'column') return columnDetail(columnAt(buckets, h.at, h.span ?? BUCKET_MS), now)
    if (h?.kind === 'step') {
      const i = steps.findIndex(s => s.id === h.id)
      return i >= 0 ? stepDetail(steps[i]!, i, steps.length, jobNow(f.props.job, now)) : null
    }
    return null
  }
  const pinnedText = describe(pinned)
  if (pinnedText) return { text: pinnedText, isPinned: true }
  const cols = f.selected !== null ? visibleColumns(f, l) : []
  const selected: Hover = f.selected !== null && cols[f.selected] ? { kind: 'column', at: cols[f.selected]!.at, span: columnWindow(f, l).span } : null
  return { text: describe(f.hover) ?? describe(selected) ?? lastCallDetail(last, now), isPinned: false }
}

export const newFrame = (props: GraphProps): Frame => ({ props, since: 0, tick: 0, shown: {}, hover: null, selected: null, fill: null, span: null, probe: null })

// New props reset the client's clock; a job that just finished starts its fill.
export function withProps(f: Frame, props: GraphProps): Frame {
  const justDone = props.job.phase === 'done' && f.props.job.phase !== 'done'
  return { ...f, props, since: 0, fill: justDone ? 0 : props.job.phase === 'done' ? f.fill : null }
}

// The heights the wave eases towards, in dots.
export function targets(f: Frame, l: Layout): Record<string, number> {
  const cols = visibleColumns(f, l)
  const heights = columnHeights(cols.map(totalOf), l.waveRows * 4)
  return Object.fromEntries(cols.map((b, i) => [String(b.at), heights[i]!]))
}

const EASE = 0.35

// One frame on: the clock runs while live, heights ease, the fill grows.
// When the column span changes the columns are new, so heights snap to them.
export function advance(f: Frame, l: Layout): Frame {
  const goal = targets(f, l)
  const { span } = columnWindow(f, l)
  const isSnap = f.span !== null && f.span !== span
  const shown: Record<string, number> = {}
  for (const [at, target] of Object.entries(goal)) {
    const was = f.shown[at] ?? 0
    const next = was + (target - was) * EASE
    shown[at] = isSnap || Math.abs(target - next) < 0.05 ? target : next
  }
  const fill = f.fill === null ? null : Math.min(1, f.fill + 0.1)
  return { ...f, shown, fill, span, tick: f.tick + 1, since: isAnimated(f.props.job.phase) ? f.since + 1 : f.since }
}

// Nothing left to move: the frame clock can stop.
export function isSettled(f: Frame, l: Layout): boolean {
  if (isAnimated(f.props.job.phase)) return false
  if (f.fill !== null && f.fill < 1) return false
  const goal = targets(f, l)
  return Object.entries(goal).every(([at, h]) => (f.shown[at] ?? 0) === h)
}

// One wave row as runs of like-styled cells, so a row is a handful of Texts.
export type Run = { text: string; color?: string; isDim?: boolean; isInverse?: boolean }

export function waveRow(f: Frame, l: Layout, row: number, highlight: number | null): Run[] {
  const cols = visibleColumns(f, l)
  const h = cols.map(b => f.shown[String(b.at)] ?? 0)
  const isQuiet = isLive(f.props.job.phase) && cols.slice(-2).every(b => totalOf(b) === 0)
  const sweep = isQuiet && row === l.waveRows - 1 ? f.tick % Math.max(1, cols.length) : -99
  const runs: Run[] = l.offset > 0 ? [{ text: BLANK.repeat(l.offset) }] : []
  cols.forEach((b, i) => {
    const right = i + 1 < h.length ? (h[i]! + h[i + 1]!) / 2 : h[i]!
    let text = brailleCell(h[i]!, right, row, l.waveRows)
    const kind = dominant(b)
    let run: Run = { text, color: kind ? KIND_COLOR[kind] : undefined, isInverse: i === highlight }
    if (text === BLANK && Math.abs(i - sweep) <= 1) {
      text = i === sweep ? '⣀' : '⡀'
      run = { text, color: 'subtle', isDim: i !== sweep, isInverse: i === highlight }
    }
    const prev = runs[runs.length - 1]
    if (prev && prev.color === run.color && prev.isDim === run.isDim && prev.isInverse === run.isInverse) prev.text += run.text
    else runs.push(run)
  })
  return runs
}

export function stepRuns(f: Frame, l: Layout, highlight: string | null): Run[] {
  const { steps, job } = f.props
  const ranges = stepRanges(steps, jobNow(job, frameNow(f)), l.barWidth)
  const filled = f.fill === null ? -1 : Math.round(f.fill * l.barWidth)
  const runs: Run[] = []
  steps.forEach((s, i) => {
    const r = ranges[i]!
    const cells = r.to - r.from
    if (cells <= 0) return
    const solid = Math.max(0, Math.min(cells, filled - r.from))
    const isInverse = s.id === highlight
    if (solid > 0) runs.push({ text: '█'.repeat(solid), color: 'success', isDim: i % 2 === 1, isInverse })
    if (cells - solid > 0) {
      const color = s.status === 'done' ? 'success' : s.status === 'active' ? 'claude' : 'subtle'
      runs.push({ text: STEP_CHAR[s.status].repeat(cells - solid), color, isDim: s.status === 'done' && i % 2 === 1, isInverse })
    }
  })
  return runs
}

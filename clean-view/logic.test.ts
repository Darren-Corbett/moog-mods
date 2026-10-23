import { expect, test } from 'claude-code/testing'

import * as L from './logic'

const ROOTS = ['/repo']
const ctx = { roots: ROOTS, isBeforeEdit: false }

test('1. the cleaner drops paths, keeps short identifiers and trims long names', () => {
  expect(L.cleanName('Refactor `src/middleware/auth/session.ts` handling')).toBe('Refactor handling')
  expect(L.cleanName('Fix `parseToken`')).toBe('Fix parseToken')
  expect(L.cleanName('update callers in api/routes')).toBe('Update callers')
  expect(L.cleanName('   ')).toBe('Working on it')
  const long = 'Rewrite the session refresh logic so that every caller shares one token cache now'
  expect(long.length).toBeGreaterThanOrEqual(80)
  const trimmed = L.cleanName(long)
  expect(trimmed.length).toBeLessThanOrEqual(50)
  expect(trimmed).toEndWith('…')
  expect(L.firstWords('fix the flaky login test in ci please and thanks')).toBe('Fix the flaky login test')
})

test('2. a task list moves through done, active and upcoming', () => {
  let c = L.reduce(L.emptyChecklist(), { type: 'job', text: 'refactor auth', now: 0 })
  for (const [id, name] of [['1', 'Read the session handling'], ['2', 'Split token refresh'], ['3', 'Update callers'], ['4', 'Run the test suite']]) {
    c = L.reduce(c, { type: 'task.create', id: id!, name: name! })
  }
  c = L.reduce(c, { type: 'task.update', id: '1', status: 'completed', now: 1000 })
  c = L.reduce(c, { type: 'task.update', id: '2', status: 'in_progress', now: 2000 })
  c = L.reduce(c, { type: 'tool.start' })
  c = L.reduce(c, { type: 'tool.start' })
  expect(c.tasks.map(t => t.status)).toEqual(['done', 'active', 'upcoming', 'upcoming'])
  expect(L.stepRight(c.tasks[1]!, false, 43000)).toBe('0:41 · 2 calls')
  expect(L.stepRight(c.tasks[2]!, true, 0)).toBe('Next')
  expect(L.stepRight(c.tasks[3]!, false, 0)).toBe('Up next')
  expect(L.progressBar(1, 4)).toBe('███░░░░░░░')
  expect(L.header(c, 72000).text).toBe('Read the session handling · 1m 12s')
})

test('3. needs you, stuck, and the end of a turn', () => {
  let c = L.reduce(L.emptyChecklist(), { type: 'job', text: 'go', now: 0 })
  c = L.reduce(c, { type: 'needs-you', reason: 'Claude needs your permission to use Bash' })
  expect(L.header(c, 0).badge).toBe('Needs you')
  c = L.reduce(c, { type: 'tool.start' })
  expect(c.phase).toBe('working')
  for (let i = 0; i < 3; i++) c = L.reduce(c, { type: 'tool.end', isError: true, isDenied: false })
  expect(L.header(c, 0).text).toBe('⚠ Stuck: A step keeps failing, Claude is trying another way')
  c = L.reduce(c, { type: 'tool.end', isError: false, isDenied: false })
  expect(c.phase).toBe('working')
  c = L.reduce(c, { type: 'turn.end', reason: 'aborted', now: 5000 })
  expect(L.header(c, 0).text).toStartWith('■ Stopped')
  const done = L.reduce(L.reduce(L.emptyChecklist(), { type: 'job', text: 'go', now: 0 }), { type: 'turn.end', reason: 'answer', now: 134000 })
  expect(L.header(done, 0).text).toBe('✓ All done · Go · took 2m 14s')
  const failed = L.reduce(done, { type: 'api-error', errorType: 'rate_limit', now: 0 })
  expect(L.header(failed, 0)).toMatchObject({ text: '⚠ Usage limit reached, try again later', detail: 'rate_limit' })
})

test('4. fold rules: what folds and what never does', () => {
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/repo/src/auth.ts' } }, ctx)).toBe('fold')
  expect(L.foldDecision({ tool: 'Grep', input: { pattern: 'refreshToken' } }, ctx)).toBe('fold')
  expect(L.foldDecision({ tool: 'Edit', input: { file_path: '/repo/src/auth.ts' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Bash', input: { command: 'ls' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/repo/a.ts' }, isErrored: true }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/etc/hosts' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/repo/../etc/hosts' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/repo/.env.local' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/repo/certs/server.pem' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'LS', input: { path: '/repo/.ssh' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Glob', input: { pattern: '**/.env*' } }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'SomeNewTool', input: {} }, ctx)).toBe('keep')
  expect(L.foldDecision({ tool: 'Read', input: { file_path: '/repo/a.ts' } }, { ...ctx, isBeforeEdit: true })).toBe('before-edit')

  let f = L.emptyFolded()
  for (const file of ['auth.ts', 'session.ts', 'routes.ts', 'index.ts']) f = L.addFolded(f, 'Read', { file_path: `/repo/src/${file}` })
  f = L.addFolded(f, 'Grep', { pattern: 'refreshToken' })
  f = L.addFolded(f, 'Grep', { pattern: 'refreshToken' })
  f = L.addFolded(f, 'WebFetch', { url: 'https://docs.example.com/a?b=1' })
  expect(L.foldedLine(f)).toBe('Folded: read auth.ts, session.ts, routes.ts +1 · searched "refreshToken" ×2 · fetched docs.example.com')
})

test('6. modes cycle and versions compare', () => {
  expect(L.nextMode('focus')).toBe('band')
  expect(L.nextMode('off')).toBe('focus')
  expect(L.isNewerVersion('2.1.309', '2.1.308')).toBe(true)
  expect(L.isNewerVersion('2.1.308-dev.20260920', '2.1.308')).toBe(false)
  expect(L.isNewerVersion('2.0.999', '2.1.308')).toBe(false)
})

test('plan steps come from the approved plan', () => {
  const plan = '# Plan\n\n## Context\nwhy\n\n1. Read `src/auth/session.ts`: the handling\n2. Split token refresh\n   - detail\n3. Run tests'
  expect(L.planSteps(plan)).toEqual(['Read', 'Split token refresh', 'Run tests'])
  let c = L.reduce(L.emptyChecklist(), { type: 'job', text: 'x', now: 0 })
  c = L.reduce(c, { type: 'planning' })
  expect(L.header(c, 0).badge).toBe('Planning')
  c = L.reduce(c, { type: 'plan', text: plan, now: 0 })
  expect(c.tasks).toHaveLength(3)
  expect(c.phase).toBe('working')
})

// ── 0.2.0: progress pane ────────────────────────────────────────────────────

const steps = (names: string[]) => {
  let c = L.reduce(L.emptyChecklist(), { type: 'job', text: 'refactor auth', now: 0 })
  names.forEach((name, i) => (c = L.reduce(c, { type: 'task.create', id: String(i + 1), name })))
  return c
}

test('pane 1. bars scale 1:3:6 and the widest fills the width', () => {
  expect(L.barWidths([10_000, 30_000, 60_000], 60)).toEqual([10, 30, 60])
  expect(L.barWidths([10_000, 30_000, 60_000], 30)).toEqual([5, 15, 30])
  expect(L.barWidths([0, 0], 20)).toEqual([0, 0])

  let c = steps(['One', 'Two', 'Three'])
  c = L.reduce(c, { type: 'task.update', id: '1', status: 'in_progress', now: 0 })
  c = L.reduce(c, { type: 'task.update', id: '1', status: 'completed', now: 10_000 })
  c = L.reduce(c, { type: 'task.update', id: '2', status: 'in_progress', now: 10_000 })
  c = L.reduce(c, { type: 'task.update', id: '2', status: 'completed', now: 40_000 })
  c = L.reduce(c, { type: 'task.update', id: '3', status: 'in_progress', now: 40_000 })
  const rows = L.timelineRows(c, 100_000, 60)
  expect(rows.map(r => r.cells)).toEqual([10, 30, 60])
  expect(rows.map(r => r.time)).toEqual(['0:10 · 0 calls', '0:30 · 0 calls', '1:00 · 0 calls'])
  expect(L.barText(10, true)).toBe('████████▒▒')
  expect(L.barText(6, false)).toBe('██████')
})

test('pane 2. a Read and an Edit during step 2 land in step 2, not step 1', () => {
  let c = steps(['One', 'Two'])
  c = L.reduce(c, { type: 'task.update', id: '1', status: 'in_progress', now: 0 })
  c = L.reduce(c, { type: 'tool.start', tool: 'Read', input: { file_path: '/repo/a.ts' }, now: 1 })
  c = L.reduce(c, { type: 'task.update', id: '1', status: 'completed', now: 2 })
  c = L.reduce(c, { type: 'task.update', id: '2', status: 'in_progress', now: 2 })
  c = L.reduce(c, { type: 'tool.start', tool: 'Read', input: { file_path: '/repo/src/auth.ts' }, now: 3 })
  c = L.reduce(c, { type: 'tool.start', tool: 'Edit', input: { file_path: '/repo/src/session.ts' }, now: 4 })
  c = L.reduce(c, { type: 'tool.start', tool: 'Grep', input: { pattern: 'refreshToken' }, now: 5 })
  expect(c.tasks[0]!.touched).toEqual({ read: ['a.ts'], edited: [], searches: [] })
  expect(c.tasks[1]!.touched).toEqual({ read: ['auth.ts'], edited: ['session.ts'], searches: ['refreshToken'] })
  expect(c.lastCall).toEqual({ tool: 'Grep', summary: 'refreshToken', at: 5 })
  expect(L.touchedLines(c.tasks[1]!.touched)).toEqual({ edited: 'Edited session.ts', read: 'Read auth.ts', searches: 'Searched "refreshToken"' })
  const many = { read: ['1', '2', '3', '4', '5', '6', '7', '8'], edited: [], searches: ['a', 'b', 'c', 'd'] }
  expect(L.touchedLines(many)).toMatchObject({ read: 'Read 1, 2, 3, 4, 5, 6 +2', searches: 'Searched "a", "b", "c" +1' })
})

test('pane 3. a failed call during the active step counts on that step and shows ⚠', () => {
  let c = steps(['One', 'Two'])
  c = L.reduce(c, { type: 'task.update', id: '1', status: 'completed', now: 0 })
  c = L.reduce(c, { type: 'task.update', id: '2', status: 'in_progress', now: 0 })
  c = L.reduce(c, { type: 'tool.start', tool: 'Bash', input: { command: 'npm test' }, now: 1 })
  c = L.reduce(c, { type: 'tool.end', isError: true, isDenied: false })
  expect(c.tasks.map(t => t.failures)).toEqual([0, 1])
  const rows = L.timelineRows(c, 10_000, 20)
  expect(L.failureText(rows[1]!.failures)).toBe('⚠ 1 failed')
  expect(L.failureText(rows[0]!.failures)).toBe('')
  expect(L.timelineAlt(rows)).toMatch(/▶ Two .*⚠ 1 failed/)
  expect(L.timelineSvg(rows)).toContain(L.SVG_COLORS.failed)
  c = L.reduce(c, { type: 'needs-you', reason: 'permission' })
  expect(L.timelineRows(c, 10_000, 20)[1]!.mark).toBe('‖')
})

test('pane 4. finishing a job adds it to history; a sixth drops the oldest', () => {
  let h: ReturnType<typeof L.addHistory> = []
  for (let i = 1; i <= 6; i++) {
    let c = L.reduce(L.emptyChecklist(), { type: 'job', text: `job ${i}`, now: i * 1000 })
    c = L.reduce(c, { type: 'turn.end', reason: i === 3 ? 'aborted' : 'answer', now: i * 1000 + 5000 })
    const r = L.jobRecord(c)
    expect(r).not.toBeNull()
    h = L.addHistory(h, r!)
  }
  expect(h).toHaveLength(5)
  expect(h.map(r => r.title)).toEqual(['Job 6', 'Job 5', 'Job 4', 'Job 3', 'Job 2'])
  expect(L.historyLine(h[0]!)).toBe('✓ Job 6 · 5s · 0 steps')
  expect(L.historyLine(h[3]!)).toBe('■ Job 3 · 5s · 0 steps')
  // A job that ends again replaces its own entry.
  expect(L.addHistory(h, { ...h[0]!, outcome: 'stopped' })).toHaveLength(5)
  // Needs you at the end of a turn is not finished.
  const waiting = L.reduce(steps(['One']), { type: 'turn.end', reason: 'answer', now: 1 })
  expect(L.jobRecord(waiting)).toBeNull()
})

test('pane 5. a 0.1.0-shaped checklist and history get defaults', () => {
  const old = { title: 'x', phase: 'working', tasks: [{ id: '1', name: 'A', status: 'active', startedAt: 0, toolCalls: 1 }] }
  const c = L.normalizeChecklist(old as never)
  expect(c.lastCall).toBeNull()
  expect(c.tasks[0]).toMatchObject({ endedAt: null, failures: 0, touched: { read: [], edited: [], searches: [] } })
  expect(() => L.timelineRows(old as never, 5000, 20)).not.toThrow()
  expect(L.reduce(old as never, { type: 'tool.start', tool: 'Read', input: { file_path: '/r/a.ts' }, now: 1 }).tasks[0]!.touched.read).toEqual(['a.ts'])
  expect(L.normalizeHistory(undefined)).toEqual([])
  expect(L.normalizeHistory([{ title: 'T' }, null, 3])).toEqual([{ title: 'T', outcome: 'done', durationMs: 0, steps: 0, startedAt: 0 }])
})

test('mode help has one line per mode', () => {
  expect(L.helpText().split('\n')).toEqual([
    'focus: band on; reads and searches folded; diffs, commands and failures shown',
    'band: band on; every tool row shown',
    'calm: band on; all tool rows hidden',
    'off: band hidden except the mode button',
  ])
})

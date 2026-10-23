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

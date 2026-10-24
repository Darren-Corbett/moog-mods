import { expect, test } from 'claude-code/testing'

import * as L from './logic'
import type { Step } from './types'

const step = (id: string, status: Step['status'], startedAt: number | null, endedAt: number | null, calls = 0): Step =>
  ({ id, name: `Step ${id}`, status, startedAt, endedAt, calls })

test('1. calls at 0s, 1s and 7s land in their slots, and sum into two 5-second columns', () => {
  let b = L.addCall([], { at: 0, kind: 'read', file: 'a.ts' })
  b = L.addCall(b, { at: 1100, kind: 'edit', file: 'a.ts' })
  b = L.addCall(b, { at: 7000, kind: 'run' })
  expect(b.map(x => x.at)).toEqual([0, 1000, 7000])
  const cols = L.denseColumns(b, 5000, 2)
  expect(cols[0]).toMatchObject({ at: 0, read: 1, edit: 1, run: 0, files: ['a.ts'] })
  expect(cols[1]).toMatchObject({ at: 5000, run: 1, read: 0, files: [] })
  expect(L.totalOf(cols[0]!)).toBe(2)
})

test('a bucket keeps at most 5 file names', () => {
  let b: ReturnType<typeof L.addCall> = []
  for (let i = 0; i < 8; i++) b = L.addCall(b, { at: 100, kind: 'read', file: `f${i}.ts` })
  expect(b[0]!.files).toEqual(['f3.ts', 'f4.ts', 'f5.ts', 'f6.ts', 'f7.ts'])
})

test('2. heights scale so the tallest fills the rows, and an empty bucket is 0', () => {
  expect(L.columnHeights([0, 2, 4], 8)).toEqual([0, 4, 8])
  expect(L.columnHeights([1, 50], 8)).toEqual([1, 8])
  expect(L.columnHeights([0, 0], 8)).toEqual([0, 0])
})

test('3. a failed call colours its bucket red, even if it holds more reads', () => {
  let b = L.addCall([], { at: 0, kind: 'read' })
  b = L.addCall(b, { at: 0, kind: 'read' })
  b = L.addCall(b, { at: 0, kind: 'run' })
  expect(L.dominant(b[0]!)).toBe('read')
  b = L.markFailed(b, 0, 'run')
  expect(b[0]).toMatchObject({ read: 2, run: 0, fail: 1 })
  expect(L.dominant(b[0]!)).toBe('fail')
  expect(L.dominant(L.emptyBucket(0))).toBe(null)
})

test('4. step widths are proportional to their durations and fill the width', () => {
  const steps = [step('a', 'done', 0, 10_000), step('b', 'done', 10_000, 40_000), step('c', 'active', 40_000, null)]
  const widths = L.stepWidths(steps, 100_000, 50)
  expect(widths).toEqual([5, 15, 30])
  expect(widths.reduce((a, b) => a + b, 0)).toBe(50)
  // Odd widths still add up, and an upcoming step keeps a cell.
  const more = L.stepWidths([...steps, step('d', 'upcoming', null, null)], 100_000, 37)
  expect(more.reduce((a, b) => a + b, 0)).toBe(37)
  expect(more.every(w => w >= 1)).toBe(true)
})

test('5. the ring buffer keeps only the last 120 buckets', () => {
  let b: ReturnType<typeof L.addCall> = []
  for (let i = 0; i < 130; i++) b = L.addCall(b, { at: i * L.BUCKET_MS, kind: 'read' })
  expect(b).toHaveLength(L.RING)
  expect(b[0]!.at).toBe(10 * L.BUCKET_MS)
  expect(L.pushRing([1, 2, 3], 4, 3)).toEqual([2, 3, 4])
  expect(L.normalizeBuckets(Array.from({ length: L.MAX_SLOTS + 50 }, (_, i) => ({ at: i })))).toHaveLength(L.MAX_SLOTS)
})

test('dense columns fill gaps with empty buckets, newest last', () => {
  const b = L.addCall([], { at: 0, kind: 'read' })
  const cols = L.denseColumns(b, 15_000, 4)
  expect(cols.map(c => c.at)).toEqual([0, 5000, 10_000, 15_000])
  expect(cols.map(L.totalOf)).toEqual([1, 0, 0, 0])
})

test('braille cells fill from the bottom', () => {
  expect(L.brailleCell(0, 0, 0, 1)).toBe(L.BLANK)
  expect(L.brailleCell(4, 4, 0, 1)).toBe('⣿')
  expect(L.brailleCell(1, 0, 0, 1)).toBe('⡀')
  // Two rows: a height of 4 dots lights the bottom row only.
  expect(L.brailleCell(4, 4, 0, 2)).toBe(L.BLANK)
  expect(L.brailleCell(4, 4, 1, 2)).toBe('⣿')
})

test('the job reducer follows task lists and failures', () => {
  let m: L.Model = { job: L.emptyJob(), steps: [] }
  m = L.reduce(m, { type: 'job', text: 'Refactor the auth middleware please now', now: 0 })
  expect(m.job).toMatchObject({ title: 'Refactor the auth middleware please now', phase: 'working', startedAt: 0 })
  m = L.reduce(m, { type: 'task.create', id: '1', name: 'Read code' })
  m = L.reduce(m, { type: 'task.update', id: '1', status: 'in_progress', now: 1000 })
  m = L.reduce(m, { type: 'tool.start', now: 2000 })
  expect(m.steps[0]).toMatchObject({ status: 'active', startedAt: 1000, calls: 1 })
  for (let i = 0; i < 3; i++) m = L.reduce(m, { type: 'tool.end', isError: true })
  expect(m.job.phase).toBe('stuck')
  m = L.reduce(m, { type: 'tool.end', isError: false })
  expect(m.job.phase).toBe('working')
  m = L.reduce(m, { type: 'turn.end', isAborted: false, now: 9000 })
  expect(m.job).toMatchObject({ phase: 'done', finishedAt: 9000 })
  expect(L.jobMs(m.job, 99_000)).toBe(9000)
})

test('the frame eases towards its heights and settles once the job is done', () => {
  const props: L.GraphProps = {
    job: { ...L.emptyJob(), title: 'x', phase: 'done', startedAt: 0, finishedAt: 5000 },
    steps: [step('a', 'done', 0, 5000)],
    buckets: L.addCall([], { at: 0, kind: 'edit' }),
    pinned: null,
    last: null,
    now: 5000,
  }
  const l = L.layout(60, 10, 1)
  let f = L.withProps(L.newFrame({ ...props, job: { ...props.job, phase: 'working' } }), props)
  expect(f.fill).toBe(0)
  const first = L.advance(f, l)
  const top = l.waveRows * 4
  expect(first.shown['0']!).toBeGreaterThan(0)
  expect(first.shown['0']!).toBeLessThan(top)
  for (let i = 0; i < 40 && !L.isSettled(f, l); i++) f = L.advance(f, l)
  expect(L.isSettled(f, l)).toBe(true)
  expect(f.shown['0']).toBe(top)
  expect(f.fill).toBe(1)
})

test('layout drops the legend below 41 body columns and hit-tests columns and steps', () => {
  // The layout gets the region: body columns less the right margin.
  expect(L.layout(40 - L.MARGIN, 10, 0).hasLegend).toBe(false)
  expect(L.layout(41 - L.MARGIN, 10, 0).hasLegend).toBe(true)
  expect(L.LEGEND_WIDTH).toBeLessThanOrEqual(41 - L.MARGIN)
  const props: L.GraphProps = {
    job: { ...L.emptyJob(), phase: 'working', startedAt: 0 },
    steps: [step('a', 'done', 0, 1000), step('b', 'active', 1000, null)],
    buckets: [], pinned: null, last: null, now: 2000, columns: 60, rows: 10, mouse: true, debug: false,
  }
  const f = L.newFrame(props)
  const l = L.layout(60, 10, 2)
  // A 2-second job fits in 500ms columns; the last holds now.
  expect(L.hitTest(f, l, l.columns - 1, l.rows.wave)).toEqual({ kind: 'column', at: 2000, span: 500 })
  expect(L.hitTest(f, l, 0, l.rows.steps)).toEqual({ kind: 'step', id: 'a' })
  expect(L.hitTest(f, l, 0, l.rows.detail)).toBe(null)
})

test('the text summary names the job, steps, calls and the last call', () => {
  const lines = L.textSummary({
    job: { ...L.emptyJob(), title: 'Fix login', phase: 'working', startedAt: 0 },
    steps: [step('a', 'done', 0, 30_000), step('b', 'active', 30_000, null)],
    buckets: L.markFailed(L.addCall(L.addCall([], { at: 0, kind: 'read' }), { at: 0, kind: 'run' }), 0, 'run'),
    last: { tool: 'Edit', summary: 'session.ts  (+12 −4)', at: 20_000 },
    now: 62_000,
  })
  expect(lines[0]).toBe('Pulse · Fix login · 1m 2s · ● working')
  expect(lines).toContain('step 2 of 2')
  expect(lines.join('\n')).toMatch(/2 calls: 1 read, 1 failed/)
  expect(lines[lines.length - 1]).toBe('Last: 0:42 ago  Edit  session.ts  (+12 −4)')
})

test('the legend rate shortens, then goes, to fit', () => {
  // Each ■ counted two cells, as a terminal treating ambiguous widths as wide draws it.
  expect(L.LEGEND_WIDTH).toBe('■ read ■ search ■ edit ■ run ■ fail'.length + 5)
  expect(L.legendRate(55, 14)).toBe('~ 14 calls/min')
  expect(L.legendRate(54, 14)).toBe('~ 14/min')
  expect(L.legendRate(49, 14)).toBe('~ 14/min')
  expect(L.legendRate(48, 14)).toBe('14/min')
  expect(L.legendRate(46, 14)).toBe('')
  for (let cols = 40; cols <= 80; cols++) {
    for (const n of [0, 7, 14, 120]) {
      const rate = L.legendRate(cols, n)
      expect(L.LEGEND_WIDTH + (rate ? 1 + L.cells(rate) : 0)).toBeLessThanOrEqual(cols)
    }
  }
})

test('a short job stretches across the wave in shorter columns; a long one uses 5 seconds', () => {
  const job = (ms: number) => ({ ...L.emptyJob(), phase: 'working' as const, startedAt: 0, finishedAt: ms })
  expect(L.columnSpan(job(20_000), 20_000, 43)).toBe(500)
  expect(L.columnSpan(job(60_000), 60_000, 43)).toBe(1500)
  expect(L.columnSpan(job(400_000), 400_000, 43)).toBe(L.BUCKET_MS)
  expect(L.columnSpan(L.emptyJob(), 0, 43)).toBe(L.BUCKET_MS)
  // A 20-second job spans 41 of 43 half-second columns, not 5 of them.
  const b = L.addCall(L.addCall([], { at: 0, kind: 'read' }), { at: 19_900, kind: 'edit' })
  const cols = L.denseColumns(b, 20_000, 43, 500)
  expect(cols.findIndex(c => c.read > 0)).toBe(2)
  expect(cols.findIndex(c => c.edit > 0)).toBe(41)
})

test('a click acts on down and lets go; leaving or straying outside clears hover', () => {
  const props: L.GraphProps = {
    job: { ...L.emptyJob(), phase: 'working', startedAt: 0 }, steps: [], buckets: [], pinned: null, last: null,
    now: 2000, columns: 43, rows: 10, mouse: true, debug: false,
  }
  const l = L.layout(43, 10, 0)
  const f = { ...L.newFrame(props), hover: { kind: 'column', at: 0 } as L.Hover }
  const down = L.pointerOutcome(f, l, { type: 'down', x: 42, y: 1, button: 'left' })
  expect(down.release).toBe(true)
  expect(down.pin).toEqual({ kind: 'column', at: 2000, span: 500 })
  expect(L.pointerOutcome(f, l, { type: 'move', x: -1, y: 1, button: 'left' })).toEqual({ hover: null, release: true })
  expect(L.pointerOutcome(f, l, { type: 'move', x: 43, y: 1 })).toEqual({ hover: null, release: true })
  expect(L.pointerOutcome(f, l, { type: 'move', x: 0, y: l.height })).toEqual({ hover: null, release: true })
  expect(L.pointerOutcome(f, l, { type: 'leave', x: 3, y: 1 })).toEqual({ hover: null, release: true })
  // A move with the button still held is a hover, never a drag.
  expect(L.pointerOutcome(f, l, { type: 'move', x: 0, y: 1, button: 'left' }).release).toBe(false)
  expect(L.pointerOutcome(f, l, { type: 'down', x: 36, y: 0, button: 'left' }).resize).toBe(-1)
  expect(L.pointerOutcome(f, l, { type: 'down', x: 40, y: 0, button: 'left' }).resize).toBe(1)
})

test('the pointer listener is set only while the mouse is on, and a release drops it', () => {
  let set = 0
  let cleared = 0
  const onPointer = () => (set++, () => void cleared++)
  const slot: L.PointerSlot = { clear: null }
  L.syncPointer(onPointer, slot, false, () => {})
  expect(set).toBe(0)
  L.syncPointer(onPointer, slot, true, () => {})
  L.syncPointer(onPointer, slot, true, () => {})
  expect(set).toBe(1)
  L.releasePointer(slot)
  expect([cleared, slot.clear]).toEqual([1, null])
  L.syncPointer(onPointer, slot, true, () => {})
  expect(set).toBe(2)
  L.syncPointer(onPointer, slot, false, () => {})
  expect(cleared).toBe(2)
})

test('the width is clamped to 28..72 and defaults to 44', () => {
  expect([L.clampWidth(undefined), L.clampWidth('x'), L.clampWidth(10), L.clampWidth(100), L.clampWidth(50.4)]).toEqual([44, 44, 28, 72, 50])
})

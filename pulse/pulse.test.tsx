import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import * as L from './logic'

const PRESENTATION = { isFullscreen: true, columns: 160 }
const PANE = {
  plugin: 'pulse',
  component: 'Pane',
  requestId: 'pulse',
  props: { title: 'Pulse', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const
const command = (args: string) => ({ command: 'pulse', args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })

// The engine beneath the plugin: every hook here stands for Claude Code.
function engine(on: On, opts: { store?: Record<string, unknown> } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on, opts.store)
  const calls = { toolRegister: 0, modelComplete: 0, opened: 0, openColumns: [] as (number | undefined)[] }
  let taskId = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('session.version', () => ({ value: { version: '2.1.308', base: '2.1.308', builtAt: '' } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', (_, e) => (calls.opened++, calls.openColumns.push(e.columns), { value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  on('ui.message', () => ({}))
  on('ui.fault', () => ({}))
  on('tool.register', () => (calls.toolRegister++, { value: undefined }) as never)
  on('model.complete', () => (calls.modelComplete++, { value: undefined }) as never)
  for (const name of ['Notification', 'StopFailure'] as const) on(`classic.${name}`, () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++taskId), subject: e.subject } } } as never
    if (e.tool === 'Bash' && e.command === 'false') return { result: 'exit 1', isError: true } as never
    return { result: {} } as never
  })
  return { clock, calls }
}

async function startJob($: Engine, text = 'Refactor auth middleware') {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: 't1' })
}

test('6. the pane draws a Client on terminal and desktop, and the text summary on vscode', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/session.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/session.ts', old_string: 'a', new_string: 'b\nc' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Client', key: 'graph' })).toBeDefined()
    await ui.resize({ columns: 60, rows: 11 })
    expect(await ui.find({ in: 'graph', type: 'Text', text: /Pulse · Refactor auth middle…/ })).toBeDefined()
    expect(await ui.find({ in: 'graph', type: 'Text', text: /Edit {2}session\.ts {2}\(\+2 −1\)/ })).toBeDefined()
    // A few frames on, the wave still draws and the legend is there.
    await ui.advance(500)
    expect(await ui.find({ in: 'graph', type: 'Text', text: /calls\/min/ })).toBeDefined()
    await ui.unmount()
  }

  const vs = await $.ui.mount({ ...PANE, surface: 'vscode' })
  expect(await vs.find({ type: 'Client' })).toBeUndefined()
  expect(await vs.find({ type: 'Text', text: /^Pulse · Refactor auth middleware · \d+s · ● working$/ })).toBeDefined()
  expect(await vs.find({ type: 'Text', text: /2 calls: 1 read, 1 edit/ })).toBeDefined()
  await vs.unmount()
})

test('below 40 columns the legend is dropped, the wave and step bar kept', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Read code', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 39 }, surface: 'terminal' })
  await ui.resize({ columns: 38, rows: 11 })
  expect(await ui.find({ in: 'graph', type: 'Text', text: /calls\/min/ })).toBeUndefined()
  expect(await ui.find({ in: 'graph', type: 'Text', text: /step 1 of 1/ })).toBeDefined()
  await ui.unmount()
})

test('7. a ui.fault from the client makes the next render show the text summary', async ($, on) => {
  engine(on)
  await startJob($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Client' })).toBeDefined()
  // A very wide pane and 1,000 steps take the graph's tree past its bounds: it fails, ui.fault fires.
  const todos = Array.from({ length: 1000 }, (_, i) => ({ content: `s${i}`, status: i % 2 ? 'completed' : 'pending' }))
  await $.tool.call({ tool: 'TodoWrite', todos } as never)
  await ui.redraw({ ...PANE.props, bodyColumns: 9_999 })
  await ui.redraw()
  expect(await ui.find({ type: 'Client' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Pulse · Refactor auth middleware/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /live graph stopped/ })).toBeDefined()
  expect((await $.command.run(command('doctor'))).text).toMatch(/Graph: failed \(.+\); showing the text summary[\s\S]*graph render on terminal/)
  await ui.unmount()
})

test('8. a ui.message pinning a column sets pinned, and a second one clears it', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/auth.ts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 11 })
  const pin = { type: 'pin', pin: { kind: 'column', at: 1_000_000 } }
  await ui.post(pin)
  expect(await ui.find({ in: 'graph', type: 'Text', text: /^◆ just now · 1 call · 1 read · auth\.ts$/ })).toBeDefined()
  await ui.post(pin)
  expect(await ui.find({ in: 'graph', type: 'Text', text: /^◆/ })).toBeUndefined()
  expect(await ui.find({ in: 'graph', type: 'Text', text: /^▸ just now {2}Read {2}auth\.ts$/ })).toBeDefined()
  await ui.unmount()
})

test('hover shows a column, a click pins it, and keys move and pin', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/auth.ts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.resize({ columns: 60, rows: 11 })
  // 60 body columns leave a 59-column region: the last column is at x 58.
  await ui.pointer({ type: 'move', x: 58, y: 1 })
  expect(await ui.find({ in: 'graph', type: 'Text', text: /^▸ just now · 1 call · 1 read · auth\.ts$/ })).toBeDefined()
  await ui.pointer({ type: 'down', x: 58, y: 1, button: 'left' })
  await ui.pointer({ type: 'leave', x: 58, y: 1 })
  expect(await ui.find({ in: 'graph', type: 'Text', text: /^◆ .*auth\.ts$/ })).toBeDefined()
  // Left moves to the column before (no calls; half a second, as the job is short); Enter pins that one instead.
  await ui.key({ key: 'left' })
  await ui.key({ key: 'return' })
  expect(await ui.find({ in: 'graph', type: 'Text', text: /^◆ just now · no calls$/ })).toBeDefined()
  await ui.unmount()
})

test('9. no tools, no prompt section, no model calls, nothing denied', async ($, on) => {
  const { calls } = engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  await startJob($)
  await $.command.run(command(''))
  const outcomes = [
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' }),
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
    await $.tool.call({ tool: 'Bash', command: 'false' }),
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] }),
  ]
  for (const ran of outcomes) expect(ran.deny).toBeUndefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.advance(2000)
  await ui.unmount()
  expect((await $.prompt.compose(COMPOSE as never)).sections.map(s => s.id)).toEqual(['intro'])
  expect(calls.toolRegister).toBe(0)
  expect(calls.modelComplete).toBe(0)
})

test('/pulse toggles the pane; session.start reopens it only when it was left open', async ($, on) => {
  const { calls } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(calls.opened).toBe(0)
  expect((await $.command.run(command(''))).text).toBe('Pulse pane opened.')
  expect(calls.opened).toBe(1)
  // A new session remembers it was open.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(calls.opened).toBe(2)
  expect((await $.command.run(command(''))).text).toBe('Pulse pane closed.')
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(calls.opened).toBe(2)
  expect((await $.command.run(command('doctor'))).text).toMatch(/^Pulse doctor\nClaude Code: 2\.1\.308\nPane: closed\nGraph: not running/)
  expect((await $.command.run(command('nope'))).text).toMatch(/^Usage: \/pulse \[doctor \| width <28-72> \| mouse /)
})

test('a pane left open in an earlier session reopens at session.start', async ($, on) => {
  const { calls } = engine(on, { store: { isPaneOpen: true } })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(calls.opened).toBe(1)
})

test('a finished job settles: the clock stops and the header says done', async ($, on) => {
  const { clock } = engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(41_000)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.advance(3000)
  expect(await ui.find({ in: 'graph', type: 'Text', text: /Pulse · Refactor auth middleware · 41s · $/ })).toBeDefined()
  expect(await ui.find({ in: 'graph', type: 'Text', text: / done/ })).toBeDefined()
  await ui.unmount()
})

// ── Drawn rows and pointer positions ───────────────────────────────────────

type Drawn = string | { type: string; props?: Record<string, unknown>; children?: Drawn[] }
const textOf = (n: Drawn): string =>
  typeof n === 'string' ? n : n.type === 'Button' ? String(n.props?.label ?? '') : (n.children ?? []).map(textOf).join('')

// A pane `bodyColumns` wide, its graph laid out at the size the Client declares.
async function mountAt($: Engine, bodyColumns: number) {
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface: 'terminal' })
  const client = await ui.find({ type: 'Client', key: 'graph' })
  const size = { columns: client!.props.width as number, rows: client!.props.height as number }
  await ui.resize(size)
  const rows = async () => ((await ui.drawn({ in: 'graph' })) as { children: Drawn[] }).children
  const detail = async () => textOf((await rows()).find(r => typeof r !== 'string' && r.props?.key === 'detail')!)
  return { ui, size, rows, detail }
}

// A job with a task list, a few calls and a long name, so every row is drawn.
async function busyJob($: Engine) {
  await startJob($, 'Refactor the whole authentication middleware and its session handling')
  await $.tool.call({ tool: 'TaskCreate', subject: 'Read code', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Split refresh', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/session.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/session.ts', old_string: 'a', new_string: 'b' })
}

test('every drawn row maps to the element drawn on it, buttons included', async ($, on) => {
  engine(on)
  await busyJob($)
  await $.command.run(command('mouse debug'))
  for (const width of [28, 44, 72]) {
    const g = await mountAt($, width)
    const rows = await g.rows()
    const keys = rows.map(r => (typeof r === 'string' ? '' : String(r.props?.key ?? '')))
    for (let y = 0; y < rows.length; y++) {
      await g.ui.pointer({ type: 'move', x: 0, y })
      const want = keys[y]!.startsWith('wave-') ? `wave ${keys[y]!.slice(5)} col 0` : keys[y] === 'steps' ? 'step 1' : keys[y]
      expect({ width, y, detail: await g.detail() }).toEqual({ width, y, detail: `▸ 0,${y} → ${want}` })
    }
    // The buttons sit flush right in the header: `[-] [+]`, as drawn.
    const header = rows[0] as { children: Drawn[] }
    const controls = textOf(header.children[header.children.length - 1]!)
    expect(controls).toBe('[-] [+]')
    const at = g.size.columns - controls.length
    for (const [x, want] of [[at - 1, 'header'], [at, '[-]'], [at + 2, '[-]'], [at + 3, 'header'], [at + 4, '[+]'], [at + 6, '[+]']] as const) {
      await g.ui.pointer({ type: 'move', x, y: 0 })
      expect({ width, x, detail: await g.detail() }).toEqual({ width, x, detail: `▸ ${x},0 → ${want}` })
    }
    await g.ui.pointer({ type: 'move', x: 0, y: rows.length })
    expect(await g.detail()).toBe(`▸ 0,${rows.length} → outside`)
    await g.ui.unmount()
  }
  await $.command.run(command('mouse debug off'))
  const g = await mountAt($, 44)
  await g.ui.pointer({ type: 'move', x: 0, y: 1 })
  expect(await g.detail()).not.toMatch(/^▸ \d+,\d+ → /)
  await g.ui.unmount()
})

test('a pointer at x hovers the wave column drawn at x, first and last included', async ($, on) => {
  engine(on)
  await busyJob($)
  for (const width of [28, 44, 72]) {
    const g = await mountAt($, width)
    const last = g.size.columns - 1
    for (const x of [0, Math.floor(last / 2), last]) {
      await g.ui.pointer({ type: 'move', x, y: 1 })
      const wave = (await g.rows())[1] as { children: Drawn[] }
      // The hovered column is drawn inverse: find where it starts in the row.
      let from = 0
      const cells = wave.children.map(c => {
        const run = { from, text: textOf(c), isInverse: typeof c !== 'string' && c.props?.inverse === true }
        from += run.text.length
        return run
      })
      const inverse = cells.filter(c => c.isInverse)
      expect({ width, x, inverse: inverse.map(c => [c.from, c.text.length]) }).toEqual({ width, x, inverse: [[x, 1]] })
    }
    await g.ui.unmount()
  }
})

test('no row is wider than bodyColumns − 1, and the rows drawn are the height declared', async ($, on) => {
  engine(on)
  await busyJob($)
  const problems: string[] = []
  for (let width = 28; width <= 72; width++) {
    const g = await mountAt($, width)
    const rows = await g.rows()
    // A row wider than the region wraps onto the next line in a terminal.
    const lines = rows.reduce((n, r) => n + Math.max(1, Math.ceil(textOf(r).length / g.size.columns)), 0)
    rows.forEach((r, y) => {
      const w = textOf(r).length
      if (w > width - 1) problems.push(`${width} cols: row ${y} is ${w} wide: ${JSON.stringify(textOf(r))}`)
    })
    const l = L.layout(g.size.columns, g.size.rows, 2)
    if (rows.length !== l.rows.detail + 1) problems.push(`${width} cols: ${rows.length} rows drawn, layout computed ${l.rows.detail + 1}`)
    if (lines !== g.size.rows) problems.push(`${width} cols: Client declares ${g.size.rows} rows, draws ${lines} lines`)
    await g.ui.unmount()
  }
  expect(problems).toEqual([])
})

test('a down with no up, then a move outside, leaves nothing hovered or held', async ($, on) => {
  engine(on)
  await busyJob($)
  const g = await mountAt($, 44)
  const inverseAt = async () => (await g.rows()).slice(1, 7).map(r => {
    let x = 0
    const at: number[] = []
    for (const c of (r as { children: Drawn[] }).children) {
      if (typeof c !== 'string' && c.props?.inverse === true) at.push(x)
      x += textOf(c).length
    }
    return at
  })
  // A down on plain header text clicks nothing; the button is never let up.
  await g.ui.pointer({ type: 'down', x: 0, y: 0, button: 'left' })
  await g.ui.pointer({ type: 'move', x: -3, y: 40, button: 'left' })
  expect(await g.detail()).toMatch(/^▸ just now {2}Edit {2}session\.ts/)
  expect((await inverseAt()).flat()).toEqual([])
  // Back inside with the button still held: a hover, not a drag, and nothing pinned.
  await g.ui.pointer({ type: 'move', x: 10, y: 1, button: 'left' })
  expect(await g.detail()).toMatch(/^▸ .* · no calls$/)
  // A down on a column pins it at once; held moves after it never pin another.
  await g.ui.pointer({ type: 'down', x: 42, y: 1, button: 'left' })
  const pinned = await g.detail()
  expect(pinned).toMatch(/^◆ just now · /)
  await g.ui.pointer({ type: 'move', x: 5, y: 1, button: 'left' })
  await g.ui.pointer({ type: 'move', x: -1, y: -1, button: 'left' })
  expect(await g.detail()).toBe(pinned)
  expect((await inverseAt()).every(at => at.length === 1 && at[0] === 42)).toBe(true)
  await g.ui.unmount()
})

test('with the mouse off the graph ignores the pointer and the keys still work', async ($, on) => {
  engine(on)
  await busyJob($)
  expect((await $.command.run(command('mouse off'))).text).toMatch(/mouse off/)
  const g = await mountAt($, 44)
  const before = await g.detail()
  await g.ui.pointer({ type: 'move', x: 42, y: 1 }).catch(() => undefined)
  await g.ui.pointer({ type: 'down', x: 42, y: 1, button: 'left' }).catch(() => undefined)
  expect(await g.detail()).toBe(before)
  await g.ui.key({ key: 'return' })
  expect(await g.detail()).toMatch(/^◆ /)
  await g.ui.unmount()
  expect((await $.command.run(command('doctor'))).text).toMatch(/Mouse: off/)
})

test('width: [-] and [+] and /pulse width resize the pane between 28 and 72, and it is kept', async ($, on) => {
  const { calls } = engine(on)
  await busyJob($)
  expect((await $.command.run(command(''))).text).toBe('Pulse pane opened.')
  expect(calls.openColumns.at(-1)).toBe(44)
  const g = await mountAt($, 44)
  const at = g.size.columns - 7
  await g.ui.pointer({ type: 'down', x: at + 4, y: 0, button: 'left' })
  expect(calls.openColumns.at(-1)).toBe(52)
  await g.ui.pointer({ type: 'down', x: at, y: 0, button: 'left' })
  await g.ui.pointer({ type: 'down', x: at, y: 0, button: 'left' })
  expect(calls.openColumns.at(-1)).toBe(36)
  await g.ui.key({ key: '+' })
  expect(calls.openColumns.at(-1)).toBe(44)
  await g.ui.unmount()
  expect((await $.command.run(command('width 100'))).text).toBe('Pulse width: 72 columns. (Limits are 28 to 72.)')
  expect(calls.openColumns.at(-1)).toBe(72)
  expect((await $.command.run(command('width 30'))).text).toBe('Pulse width: 30 columns.')
  expect((await $.command.run(command('width wide'))).text).toMatch(/^Usage/)
  // A new session opens at the saved width.
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(calls.openColumns.at(-1)).toBe(30)
})

test('at 28 columns the header is the dot, the time and a trimmed name, and there is no legend', async ($, on) => {
  engine(on)
  await busyJob($)
  const g = await mountAt($, 28)
  const rows = await g.rows()
  expect(textOf(rows[0]!)).toMatch(/^● \d+s · Refactor.*…\[-\] \[\+\]$/)
  expect(rows.some(r => typeof r !== 'string' && r.props?.key === 'legend')).toBe(false)
  await g.ui.unmount()
})

// Cells a string takes in a terminal: wide (CJK, fullwidth, emoji) two, combining marks none.
// With `isAmbiguousWide`, also the symbols a terminal may draw two wide: ● ■ ◆ ↻ − … · → ▸,
// the step bar's blocks, the rule and the braille the wave is drawn in.
const AMBIGUOUS = /[●■◆↻−…·→▸▶○✓█▓░─\u2800-\u28ff]/u
function cellWidth(s: string, isAmbiguousWide = false): number {
  let n = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue
    const isWide = (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1f64f) || (c >= 0x1f900 && c <= 0x1f9ff) || (c >= 0x20000 && c <= 0x3fffd) ||
      (isAmbiguousWide && AMBIGUOUS.test(ch))
    n += isWide ? 2 : 1
  }
  return n
}

// Every Text that is not inside another Text, with where it sits.
function rowTexts(n: Drawn, path = ''): { path: string; wrap: unknown }[] {
  if (typeof n === 'string') return []
  if (n.type === 'Text') return [{ path, wrap: n.props?.wrap }]
  return (n.children ?? []).flatMap((c, i) => rowTexts(c, `${path}/${typeof c === 'string' ? i : String(c.props?.key ?? c.type)}`))
}

// The wave, the rule and the step bar are one glyph per column by design, so drawn two wide they
// cannot fit: those rows must cut at the edge instead, never wrap. Every other row must fit.
const isCellGraphic = (key: string) => key.startsWith('wave-') || key === 'rule' || key === 'steps'

// Everything on at once, built up a step at a time; after each step every check runs on the frame as drawn.
const LONG_NAMES = {
  plain: 'Refactor the whole authentication middleware and its session handling',
  wide: '重构认证中间件 🚀 and its 会话处理 so the tokens refresh ✅',
}
const EVERYTHING_WIDTHS = [28, 36, 44, 60, 72]

for (const [nameKind, name] of Object.entries(LONG_NAMES)) {
  test(`everything on (${nameKind} name): rows fit, and the declared height is what is drawn, in the same render`, async ($, on) => {
    engine(on)
    const problems: string[] = []
    for (const bodyRows of [30, 8]) {
      for (const width of EVERYTHING_WIDTHS) {
        await $.command.run(command('mouse debug off'))
        await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
        await $.turn.complete({ turnId: 't0', answer: '' } as never).catch(() => undefined)
        const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width, scroll: { offset: 0, bodyRows } }, surface: 'terminal' })
        const client0 = await ui.find({ type: 'Client', key: 'graph' })
        await ui.resize({ columns: client0!.props.width as number, rows: client0!.props.height as number })

        const check = async (state: string) => {
          const client = await ui.find({ type: 'Client', key: 'graph' })
          const columns = client!.props.width as number
          const height = client!.props.height as number
          const rows = ((await ui.drawn({ in: 'graph' })) as { children: Drawn[] }).children
          if (height > bodyRows) problems.push(`${nameKind} · ${width} cols · bodyRows ${bodyRows} · ${state}: Client declares ${height} rows, the dock has ${bodyRows}`)
          rows.forEach((r, y) => {
            for (const t of rowTexts(r)) {
              if (t.wrap !== 'truncate-end') problems.push(`${nameKind} · ${width} cols · ${state}: row ${y} Text ${t.path} can wrap (wrap=${String(t.wrap)})`)
            }
          })
          for (const isAmbiguousWide of [false, true]) {
            const at = `${nameKind} · ${width} cols · bodyRows ${bodyRows} · ${state}${isAmbiguousWide ? ' · ambiguous as 2' : ''}`
            let lines = 0
            rows.forEach((r, y) => {
              const key = typeof r === 'string' ? '' : String(r.props?.key ?? '')
              const w = cellWidth(textOf(r), isAmbiguousWide)
              const isCut = isAmbiguousWide && isCellGraphic(key)
              if (w > width - 1 && !isCut) problems.push(`${at}: row ${y} is ${w} cells wide (limit ${width - 1}): ${JSON.stringify(textOf(r))}`)
              // A row wider than the region wraps onto the next line in a terminal; a cut row stays one.
              lines += isCut ? 1 : Math.max(1, Math.ceil(w / columns))
            })
            if (lines !== height) problems.push(`${at}: Client declares ${height} rows, draws ${lines} lines (${rows.length} rows)`)
          }
        }
        await startJob($, name)
        await check('long job name')
        const subjects = ['Read the existing middleware code', 'Split the refresh path out', 'Rewrite the token cache', 'Add retry on expiry', 'Update every caller', 'Write the migration notes', 'Run the whole test suite', 'Clean up the old helpers']
        for (const subject of subjects) await $.tool.call({ tool: 'TaskCreate', subject, description: '' })
        for (const id of ['1', '2']) await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed' })
        await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' })
        await check('8 steps, one active')
        await $.tool.call({ tool: 'Bash', command: 'false' })
        await $.tool.call({ tool: 'Bash', command: 'false' })
        await check('failures')
        await $.tool.call({ tool: 'Bash', command: `cd /repo/packages/auth && bun test --coverage --reporter=verbose src/middleware/session/refresh.test.ts ${nameKind === 'wide' ? '# 测试 🚀 全部' : '| tee /tmp/out.log'}` })
        await check('long Bash command in the detail line')
        await $.tool.call({ tool: 'Read', file_path: `/repo/packages/auth/src/middleware/session/${nameKind === 'wide' ? '会话刷新令牌缓存处理程序' : 'very-long-session-refresh-token-cache-handler'}.test.ts` })
        await check('long file path in the detail line')
        for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'false' })
        await check('stuck')
        await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
        await check('needs you')
        await ui.post({ type: 'pin', pin: { kind: 'column', at: L.bucketAt(1_000_000) } })
        await check('pinned column')
        await ui.post({ type: 'pin', pin: { kind: 'step', id: '3' } })
        await check('pinned step')
        await $.command.run(command('mouse debug'))
        const client = await ui.find({ type: 'Client', key: 'graph' })
        await ui.pointer({ type: 'move', x: (client!.props.width as number) - 1, y: (client!.props.height as number) - 1 })
        await check('mouse debug')
        await ui.advance(1500)
        await check('mouse debug, 1.5s on')
        await ui.unmount()
        // The text summary, where the graph is not drawn, cuts its rows too.
        const vs = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: width }, surface: 'vscode' })
        for (const t of rowTexts((await vs.drawn()) as Drawn)) {
          if (t.wrap !== 'truncate-end') problems.push(`${nameKind} · ${width} cols · summary Text ${t.path} can wrap`)
        }
        for (const t of (await vs.findAll({ type: 'Text' }))) {
          const w = cellWidth(String(t.text ?? ''), true)
          if (w > width - 1) problems.push(`${nameKind} · ${width} cols · summary row is ${w} cells (ambiguous as 2): ${JSON.stringify(t.text)}`)
        }
        await vs.unmount()
      }
    }
    expect(problems).toEqual([])
  })
}

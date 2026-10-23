import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PRESENTATION = { isFullscreen: false, columns: 100 }
const PANE = {
  plugin: 'clean-view',
  component: 'Pane',
  requestId: 'clean-view-progress',
  props: { title: 'Progress', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const
const SURFACES = ['terminal', 'desktop', 'vscode'] as const

// The engine beneath the plugin, as in clean-view.test.tsx, plus the pane calls.
function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const panes = { opened: 0, closed: 0 }
  let taskId = 0
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'clean' } }))
  on('session.version', () => ({ value: { version: '2.1.308', base: '2.1.308', builtAt: '' } }) as never)
  on('fs.exists', () => ({ value: false }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => (panes.opened++, { value: { isPlaced: true } }))
  on('ui.close', () => (panes.closed++, { value: undefined }) as never)
  for (const name of ['Notification', 'PermissionDenied', 'StopFailure', 'UserPromptSubmit'] as const) on(`classic.${name}`, () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++taskId), subject: e.subject } } } as never
    if (e.tool === 'Bash' && e.command === 'false') return { result: 'exit 1', isError: true } as never
    return { result: {} } as never
  })
  return { clock, panes }
}

const command = (args: string) => ({ command: 'clean', args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })

async function job($: Engine, clock: ReturnType<typeof engine>['clock']) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Refactor the auth middleware', turnId: 't1' })
  for (const subject of ['Read the session handling', 'Split token refresh', 'Update callers']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: '' })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/session.ts' })
  await clock.advance(10_000)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/token.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/token.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Grep', pattern: 'refreshToken' } as never)
  await $.tool.call({ tool: 'Bash', command: 'false' })
  await clock.advance(20_000)
}

test('2, 3. the pane shows step 2 touched files and its failure on the active row', async ($, on) => {
  const { clock } = engine(on)
  await job($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1 of 3 steps/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Edited token\.ts$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Read \S+\.ts/ })).toBeUndefined() // token.ts was edited, so it's listed there
  expect(await ui.find({ type: 'Text', text: /Searched "refreshToken"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Last: Bash · false/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⚠ 1 failed/ })).toBeDefined()
  expect(await ui.findAll({ type: 'Text', text: /⚠/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /▒/ })).toBeDefined()
  await ui.unmount()
})

test('4. finishing a job adds it to the recent jobs', async ($, on) => {
  const { clock } = engine(on)
  await job($, clock)
  for (const id of ['2', '3']) await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'Recent jobs' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ Read the session handling · 30s · 3 steps/ })).toBeDefined()
  await ui.unmount()
})

test('5. a 0.1.0-shaped state renders the pane without throwing', async ($, on) => {
  engine(on)
  const old = {
    title: 'Old job', phase: 'working', needsYouReason: null, stuckReason: null, errorText: null, errorType: null,
    startedAt: 990_000, finishedAt: null, isCollapsed: false, toolCalls: 3, failStreak: 0,
    tasks: [
      { id: '1', name: 'Old done step', status: 'done', startedAt: 990_000, toolCalls: 1 },
      { id: '2', name: 'Old active step', status: 'active', startedAt: 995_000, toolCalls: 2 },
    ],
  }
  // The session holds what 0.1.0 wrote until the mod writes its own.
  let isWritten = false
  on('state.set', { plugin: 'clean-view', key: 'checklist' }, (_, e, next) => ((isWritten = true), next(e)))
  on('state.get', { plugin: 'clean-view', key: 'checklist' }, (_, e, next) => (isWritten ? next(e) : ({ value: { value: old, version: 0 } }) as never))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // A tool call runs the reducer over the old shape too.
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Old done step/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Clean View fills this in/ })).toBeUndefined()
    await ui.unmount()
  }
  expect((await $.command.run(command('doctor'))).text).toMatch(/Errors caught: none/)
})

test('6. the timeline is an Svg on desktop and text on terminal and vscode', async ($, on) => {
  const { clock } = engine(on)
  await job($, clock)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svg = await ui.find({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svg).toBeDefined()
      expect(String(svg?.props.source).length).toBeLessThan(131_072 / 10)
      expect(String(svg?.props.alt)).toMatch(/▶ Split token refresh/)
    } else {
      expect(svg).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /Split token refresh/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('7. in off mode the pane shows one line', async ($, on) => {
  const { clock } = engine(on)
  await job($, clock)
  await $.command.run(command('off'))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = await ui.findAll({ type: 'Text' })
    expect(texts.map(t => t.text)).toEqual(['Clean View is off. Run /clean band to turn it back on.'])
    await ui.unmount()
  }
})

test('8. /clean pane opens the pane and closes it again; the choice is remembered', async ($, on) => {
  const { panes } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(panes.opened).toBe(0) // never opened for someone who hasn't asked
  expect((await $.command.run(command('pane'))).text).toBe('Progress pane opened.')
  expect(panes).toEqual({ opened: 1, closed: 0 })
  expect((await $.command.run(command('pane'))).text).toBe('Progress pane closed.')
  expect(panes).toEqual({ opened: 1, closed: 1 })

  await $.command.run(command('pane'))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  expect(panes.opened).toBe(3) // reopened at start because it was left open
})

test('the band has a Pane button next to the mode button, and /clean help lists the modes', async ($, on) => {
  const { panes } = engine(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'clean-view', component: 'AbovePrompt', surface: 'terminal',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  } as never)
  expect(await band.find({ type: 'Button', key: 'mode' })).toBeDefined()
  await band.press({ key: 'pane' })
  expect(panes.opened).toBe(1)
  await band.unmount()

  const help = (await $.command.run(command('help'))).text
  expect(help).toContain('focus: band on; reads and searches folded; diffs, commands and failures shown')
  expect(help).toContain('band: band on; every tool row shown')
  expect(help).toContain('calm: band on; all tool rows hidden')
  expect(help).toContain('off: band hidden except the mode button')
})

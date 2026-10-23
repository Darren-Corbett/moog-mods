import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PRESENTATION = { isFullscreen: false, columns: 100 }
const BAND = {
  plugin: 'clean-view',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: true, maxRows: 20, bodyColumns: 80, scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const
const row = (tool: string, input: unknown, isErrored = false) => ({
  plugin: 'clean-view',
  component: 'ToolUse',
  requestId: `id-${tool}`,
  props: { tool_use_id: `id-${tool}`, tool, input, isRunning: false, isErrored, isInterrupted: false },
} as const)
const result = (tool: string, isErrored: boolean, id = `res-${tool}`) => ({
  plugin: 'clean-view',
  component: 'ToolResult',
  requestId: id,
  props: { tool_use_id: id, tool, output: {}, isErrored },
} as const)

// The engine beneath the plugin: every hook here stands for Claude Code.
function engine(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const calls = { toolRegister: 0, modelComplete: 0 }
  let taskId = 0
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'clean' } }))
  on('session.version', () => ({ value: { version: '2.1.308', base: '2.1.308', builtAt: '' } }) as never)
  on('fs.exists', () => ({ value: false }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }) as never)
  on('tool.register', () => (calls.toolRegister++, { value: undefined }) as never)
  on('model.complete', () => (calls.modelComplete++, { value: undefined }) as never)
  for (const name of ['Notification', 'PermissionDenied', 'StopFailure', 'UserPromptSubmit'] as const) on(`classic.${name}`, () => ({}))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++taskId), subject: e.subject } } } as never
    if (e.tool === 'Bash' && e.command === 'false') return { result: 'exit 1', isError: true } as never
    return { result: {} } as never
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine {e.component}</Text>
  })
  return { clock, calls }
}

async function startJob($: Engine, text = 'Refactor the auth middleware') {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text, turnId: 't1' })
}

const command = (args: string) => ({ command: 'clean', args, origin: { kind: 'composer' as const }, presentation: PRESENTATION })

test('2. a task list renders ✓ / ▶ with time and tool count / Next / Up next, on terminal and desktop', async ($, on) => {
  const { clock } = engine(on)
  await startJob($)
  for (const subject of ['Read the session handling', 'Split token refresh into own fn', 'Update callers', 'Run the test suite']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: '' })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: 'Bash', command: 'ls' })
  await clock.advance(41_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: '✓' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '▶' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0:4\d · 6 calls/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Next' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Up next' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Progress 1 of 4/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'mode' })).toBeDefined()
    await ui.unmount()
  }
})

test('3. a permission prompt shows Needs you', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /Needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /permission to use Bash/ })).toBeDefined()
    await ui.unmount()
  }
})

test('4. focus mode folds an in-repo Read and keeps diffs, failures, outside reads, .env and unknown tools', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/auth.ts', tool_use_id: 'read-1' } as never)

  for (const surface of SURFACES) {
    const visible = async (target: Parameters<typeof $.ui.mount>[0]) => {
      const ui = await $.ui.mount({ ...target, surface } as never)
      const found = await ui.find({ type: 'Text', text: /engine/ })
      await ui.unmount()
      return found !== undefined
    }
    expect(await visible(row('Read', { file_path: '/repo/src/auth.ts' }) as never)).toBe(false)
    expect(await visible(result('Read', false, 'read-1') as never)).toBe(false)
    expect(await visible(row('Edit', { file_path: '/repo/src/auth.ts', old_string: 'a', new_string: 'b' }) as never)).toBe(true)
    expect(await visible(result('Edit', false) as never)).toBe(true)
    expect(await visible(result('Bash', true) as never)).toBe(true)
    expect(await visible(result('Bash', false) as never)).toBe(false)
    expect(await visible(row('Read', { file_path: '/etc/hosts' }) as never)).toBe(true)
    expect(await visible(row('Read', { file_path: '/repo/.env' }) as never)).toBe(true)
    expect(await visible(row('BrandNewTool', {}) as never)).toBe(true)

    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /Folded: read auth\.ts/ })).toBeDefined()
    await band.press({ key: 'show' })
    await band.unmount()
    expect(await visible(row('Read', { file_path: '/repo/src/auth.ts' }) as never)).toBe(true)
    const again = await $.ui.mount({ ...BAND, surface })
    await again.press({ key: 'show' })
    await again.unmount()
  }
})

test('5. /clean off hides the band but keeps the button; /clean calm hides all tool rows', async ($, on) => {
  engine(on)
  await startJob($)
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  await $.command.run(command('off'))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Button', key: 'mode' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Refactor/ })).toBeUndefined()
    await ui.unmount()
  }

  await $.command.run(command('calm'))
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...row('Edit', { file_path: '/repo/a.ts' }), surface } as never)
    expect(await ui.find({ type: 'Text', text: /engine/ })).toBeUndefined()
    await ui.unmount()
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /Refactor/ })).toBeDefined()
    await band.unmount()
  }

  const ran = await $.command.run(command(''))
  expect(ran.text).toBe('Clean View: Off')
  expect((await $.command.run(command('doctor'))).text).toMatch(/Clean View doctor[\s\S]*Mode: off/)
})

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as const

test('6. by default: no tools registered, no prompt section, no model calls', async ($, on) => {
  const { calls } = engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  await startJob($)
  await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const composed = await $.prompt.compose(COMPOSE as never)
  expect(composed.sections.map(s => s.id)).toEqual(['intro'])
  expect(calls).toEqual({ toolRegister: 0, modelComplete: 0 })
})

test('6. with nudgeTaskLists the prompt section appears', { options: { nudgeTaskLists: true } }, async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  const composed = await $.prompt.compose(COMPOSE as never)
  expect(composed.sections.map(s => s.id)).toEqual(['intro', 'clean-view:task-lists'])
})

test('7. a one-shot question with no tasks and no tool calls shows no band', async ($, on) => {
  engine(on)
  await startJob($, 'what does this regex do?')
  await $.turn.complete({ answer: 'It matches digits.', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.findAll({ type: 'Text' })).toHaveLength(0)
    expect(await ui.find({ type: 'Button', key: 'mode' })).toBeDefined()
    await ui.unmount()
  }
})

test('8. a render hook that throws falls back to the default drawing', async ($, on) => {
  engine(on)
  await startJob($)
  // Props of a shape the mod doesn't expect (as a future Claude Code might send) make its hook throw.
  const group = { plugin: 'clean-view', component: 'ToolGroup', requestId: 'g1', props: { calls: [null], isActive: false, isExpanded: false } }
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...group, surface } as never)
    expect(await ui.find({ type: 'Text', text: /engine ToolGroup/ })).toBeDefined()
    await ui.unmount()
  }
  expect((await $.command.run(command('doctor'))).text).toMatch(/Errors caught:\n- ToolGroup:/)
})

test('9. no tool call is ever denied', async ($, on) => {
  engine(on)
  await startJob($)
  const outcomes = [
    await $.tool.call({ tool: 'Read', file_path: '/repo/.env' }),
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
    await $.tool.call({ tool: 'Bash', command: 'false' }),
    await $.tool.call({ tool: 'Bash', command: 'false' }),
    await $.tool.call({ tool: 'Bash', command: 'false' }),
    await $.tool.call({ tool: 'AskUserQuestion', questions: [] }),
  ]
  for (const ran of outcomes) expect(ran.deny).toBeUndefined()
})

test('9. still true with the pane open: no tools, no prompt section, no model calls, nothing denied', async ($, on) => {
  const { calls } = engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }))
  await startJob($)
  await $.command.run(command('pane'))
  await $.command.run(command('help'))
  const outcomes = [
    await $.tool.call({ tool: 'Read', file_path: '/repo/a.ts' }),
    await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' }),
    await $.tool.call({ tool: 'Bash', command: 'false' }),
  ]
  for (const ran of outcomes) expect(ran.deny).toBeUndefined()
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const pane = await $.ui.mount({
    plugin: 'clean-view', component: 'Pane', requestId: 'clean-view-progress', surface: 'desktop',
    props: { title: 'Progress', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as never)
  expect(await pane.find({ type: 'Text', text: /Recent jobs/ })).toBeDefined()
  await pane.unmount()
  expect((await $.prompt.compose(COMPOSE as never)).sections.map(s => s.id)).toEqual(['intro'])
  expect(calls).toEqual({ toolRegister: 0, modelComplete: 0 })
})

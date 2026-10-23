import type { Register } from 'claude-code'

// Placeholder so the repo validates and installs before Clean View is built.
// Claude Code replaces this file when you run BUILD-PROMPT.md; the final
// version should call registerCleanView(on) from ../clean-view.tsx.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clean',
      description: 'Clean View (not built yet)',
    })

    return next(e)
  })

  on('command.run', { command: 'clean' }, async () => ({
    text: 'Clean View is not built yet. Open this folder in Claude Code and run BUILD-PROMPT.md.',
  }))
}

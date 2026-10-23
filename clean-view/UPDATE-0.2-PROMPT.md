Before you start: read this whole prompt, the existing Clean View code in this folder (`clean-view.tsx`, `logic.ts`, `types/index.d.ts`, the tests) and `BUILD-PROMPT.md`. Then tell me in plain language what will change, every file you will create or overwrite, and every command you will run. Wait for my yes before you begin.

Update Clean View from 0.1.0 to **0.2.0** by adding a **progress pane**: a live visual of where the job is up to, kept beside the chat. Everything in `BUILD-PROMPT.md` still applies, especially **observe, don't steer** (no tools, no system-prompt text by default, no model calls, no denied tool calls) and **fail safe** (any render error falls back to Claude Code's own drawing).

If a `plugin-authoring` skill is available, load it and follow it. Otherwise use the types Claude Code writes to `.claude-plugin/types/` as the source of truth.

## Opening and closing the pane

- `/clean pane` toggles it. Add a small `Pane` button to the band's header row, next to the mode button.
- Open it with `$.ui.open({ id: 'clean-view-progress', title: 'Progress' })`, drawn by a `ui.render` hook on `{ component: 'Pane', requestId: 'clean-view-progress' }`.
- Remember whether it was open in `$.store` and reopen it at `session.start` if it was. Never open it on its own for a user who hasn't asked.
- The pane works in every mode except **off**. In off it shows one line: "Clean View is off. Run /clean band to turn it back on."

## What the pane shows

Top to bottom:

**1. Job header**: job name, phase badge (Working, Planning, Needs you, Stuck, Stopped, All done) and total elapsed time.

**2. Overall progress**: a full-width bar of steps done out of total, labelled "2 of 5 steps". If there is no task list, show "No task list yet" with the tool-call count instead.

**3. Timeline**: one row per step, in order:
```
✓ Read the session handling    ██████              0:38 · 5 calls
▶ Split token refresh          ████████▒▒          1:12 · 9 calls  ⚠ 1 failed
○ Update callers
○ Run the test suite
```
- The bar length is the step's share of total elapsed time, scaled to the widest bar the pane fits. The active step's bar grows live and ends in a lighter segment.
- Done steps are dimmed, the active step is bold, and upcoming steps have no bar.
- Mark failed tool calls on the step they happened in, and ‖ on the active step while it needs you.

**4. Active step detail**, under the timeline:
- Files read and files edited in this step (basenames, up to 6 each, then "+N"). Edited files first, in the accent colour.
- Searches run (patterns, up to 3).
- The last tool call: its tool name and a cleaned one-line summary, plus how long ago it ran.

**5. Recent jobs**: the last 5 finished jobs, one line each: ✓ or ■ or ⚠, name, duration and step count. Keep this history in `$.store` so it survives restarts, capped at 5.

## Surfaces

- **Desktop**: draw the timeline as an `Svg` element: a horizontal Gantt-style chart with one row per step, coloured by status (done green, active accent, failed red tick marks). Use `Text` and `Box` for everything else. Keep the SVG well under the 131,072-character limit.
- **Terminal**: draw it with `Text` and block characters as shown above. Size everything from `bodyColumns` and `scroll.bodyRows`, and never wrap a row.
- **VS Code**: same as terminal, but without `Svg`.
- Check `e.surface` and use only elements that surface supports. If drawing fails, return `next(e)`.

## State changes

- Extend `Task` with `endedAt: number | null`, `failures: number`, and `touched: { read: string[]; edited: string[]; searches: string[] }`.
- Add `lastCall: { tool: string; summary: string; at: number } | null` to `Checklist`.
- Add `history` (an array of `{ title, outcome: 'done' | 'stopped' | 'stuck' | 'error', durationMs, steps }`, capped at 5) and `isPaneOpen` to plugin state.
- Values saved by 0.1.0 are missing these fields. Fill defaults when reading so an upgraded session never crashes.
- Put all new logic in `logic.ts` as pure functions: bar scaling, timeline rows, the per-step touched lists and the history cap. Only wiring and drawing go in `clean-view.tsx`. If that file goes past about 450 lines, move the pane drawing into `pane.tsx`.

## Mode help

Make `/clean help` print one line per mode:
- **focus**: band on; reads and searches folded; diffs, commands and failures shown
- **band**: band on; every tool row shown
- **calm**: band on; all tool rows hidden
- **off**: band hidden except the mode button

Mention `/clean help` in the toast the first time someone cycles modes.

## Tests (add to the existing ones; all old tests must still pass)

1. Bar scaling: three steps of 10s, 30s and 60s give bars in a 1:3:6 ratio, and the widest equals the available width.
2. A Read and an Edit during step 2 appear in step 2's `touched`, not step 1's.
3. A failed tool call during the active step increments that step's `failures` and shows ⚠ in its row.
4. Finishing a job adds it to `history`. A sixth job drops the oldest.
5. A 0.1.0-shaped state with no `touched`, `failures` or `history` renders the pane without throwing.
6. The pane on `desktop` contains an `Svg`; on `terminal` and `vscode` it doesn't.
7. In off mode the pane shows the "Clean View is off" line.
8. `/clean pane` opens the pane, and running it again closes it.
9. Still true: no tools registered, no `prompt.compose` section by default, no `$.model` calls, no tool call denied.

## Done means

- `/clean pane` opens a live progress view beside the chat that updates as Claude works.
- The band, modes and folding behave exactly as in 0.1.0.
- `version` in `plugin.json` is `0.2.0`, the README mentions the pane and `/clean help`, `claude plugin validate --strict .` passes and all tests pass.
- No commit or push unless I ask.

When you're done, tell me how to open the pane, what each part of it shows, and anything you couldn't do on a particular surface.
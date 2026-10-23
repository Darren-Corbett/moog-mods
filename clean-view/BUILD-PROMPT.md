Before you start: read this entire prompt and make sure you understand it. Then, before you do anything else, tell me in plain language what this prompt will do, every file you will create, overwrite or delete, every script you will run on my machine, and anything that costs money or is hard to undo. Wait for my yes before you begin.

Build me a Claude Code mod called **Clean View** for a developer who wants less noise, not less information. One checklist band sits above the prompt showing the plan, the current step and progress. Read-only noise gets folded into a summary line that still names what was touched; the things I review as a developer (edits, diffs, commands, failures) stay visible.

Design rules that override everything below:
- **Observe, don't steer.** By default the mod adds nothing to the system prompt, registers no tools, makes no model calls and denies no tool calls. It only reads events and changes what is drawn. Zero extra tokens, zero extra cost, Claude behaves exactly as it would without the mod.
- **Fail safe.** Any error in a render hook falls back to Claude Code's own drawing. The mod must never be the reason I can't see something.
- **Small.** Keep the hooks module thin; put all logic in pure functions that are easy to test.

If a `plugin-authoring` skill is available, load it and follow it. Otherwise use the type definitions Claude Code writes to `.claude-plugin/types/` for my installed version as the source of truth. Build this as a mod (hooks module plugin) that hot-reloads with `--plugin-dir`. No shell-script hooks, no MCP server.

## What I should see

```
Refactor the auth middleware · 1m 12s            [ Clean View: Focus ]
✓ Read the session handling           ●●●●●●●●●●  Done
▶ Split token refresh into own fn     0:41 · 6 steps
○ Update callers                                  Next
○ Run the test suite                              Up next
Progress 1 of 4  ███░░░░░░░
Folded: read auth.ts, session.ts, routes.ts +1 · searched "refreshToken" ×2   [ show ]
```

- **Header:** job name and elapsed time. The name is the first task's title if a task list exists, otherwise the first 6 words of my prompt, cleaned. No model call.
- **Done:** green ✓, dimmed name, "Done".
- **Current:** ▶, bold name, time on this step and how many tool calls it has taken. No invented percentages.
- **Upcoming:** dimmed; first says "Next", the rest "Up next".
- **Progress bar:** real progress only: steps done out of steps total, 10 cells.
- **Folded line:** names what was folded, not just a count: file basenames read (up to 3, then "+N"), search patterns, URLs' hostnames. `show` unfolds them for this turn.
- **Mode button:** right of the header on every screen, even when idle. Clicking cycles the mode and shows a short toast.

If there is no task list, show no step rows: just the header, elapsed time, tool-call count and the folded line.

Header states:

| State | Header shows |
|---|---|
| Working | Job name · time running |
| Planning | "Planning" badge while plan mode is active; steps fill in from the approved plan |
| Needs you | Highlighted **Needs you** badge and the reason. ▶ becomes ‖ |
| Stuck | ⚠ Stuck: one-sentence reason |
| Stopped | ■ Stopped · job name · you pressed Esc |
| Done | ✓ All done · job name · took 2m 14s. Collapses to one line after 5 seconds |

## Modes (`/clean focus|band|calm|off`, no argument cycles)

| Mode | Band | Tool rows |
|---|---|---|
| **focus** (default) | On | Fold read-only rows (Read, Glob, Grep, LS, ToolSearch, WebSearch, WebFetch, TaskCreate/TaskUpdate/TodoWrite) into the folded line. Keep Edit/Write/NotebookEdit with diffs, Bash commands, and every failed result. Bash output shows only on failure or when expanded. |
| **band** | On | Everything visible as normal |
| **calm** | On | Hide all ToolUse/ToolResult/ToolGroup rows and blank the ToolProgress hint |
| **off** | Hidden except the mode button | Everything normal |

Store the mode in plugin state and save it with `$.store` so it survives restarts.

**Never fold these, even in focus mode** (so folding can't hide a mistake):
- Any failed tool result.
- A Read, Glob or Grep outside the session's working directory or repo root.
- A read of a sensitive-looking file: `.env*`, anything under `.ssh`, `*.pem`, `*key*`, `*secret*`, `*credential*`.
- The first read of a file Claude then edits in the same step, shown as a one-line "read X before editing" so I can see what it based the edit on.

## How it works

**1. Plan from what already exists.** Build the checklist from TaskCreate / TaskUpdate / TodoWrite (whichever the session has) and from the plan I approve in plan mode. No custom tools.

**2. Optional nudge, off by default.** Add a `userConfig` boolean `nudgeTaskLists` (default `false`). Only when it's true, add a short `prompt.compose` section asking Claude to create a 2 to 8 step task list for work longer than about three tool calls, with step names under 50 characters that start with a verb. Never deny tool calls in any configuration. Only the main agent counts; ignore subagents.

**3. Fill the checklist from events**
- **`turn.start`:** a real prompt (not a slash command) while nothing is running starts a job. Show no band until the first task is created or the first tool runs, so quick Q&A stays clean.
- **Permission prompts and questions** (`classic.Notification`, AskUserQuestion): **Needs you**, cleared when the next tool runs or I reply.
- **Failures:** if I deny a permission: "Stuck: you said no to a step, so Claude paused". After 3 failed tool calls in a row: "Stuck: a step keeps failing, Claude is trying another way". A success clears it.
- **`turn.complete`:**
  - API errors become one calm sentence plus the raw error type in dim text: rate limit ("usage limit reached, try again later"), overloaded ("servers busy, try again in a minute"), context too long ("run /compact and retry"), network ("connection dropped"), auth ("run /login").
  - Refusal: "Claude couldn't help with that request".
  - Esc: Stopped.
  - Unfinished steps: Needs you, "Claude is waiting for your reply".
  - Otherwise All done, collapse after 5 seconds.

## Robustness against Claude Code updates

- Attach `.catch` to every hook. On any error or timeout in a `ui.render` hook, return `next(e)` so Claude Code draws its default. Log the error once per session with `$.ui.log`, not on every redraw.
- Read every `e.props` field defensively (optional chaining, defaults). Unknown tool names are treated as "keep visible", never "fold".
- Use only element props available since the oldest version I support; if you use version-gated props (`weight`, spacing step names), check `$.session.version()` and fall back to `bold` and numeric spacing.
- At `session.start`, compare `$.session.version()` with the version recorded in `TESTED_VERSION` in the source. If newer, show one toast: "Clean View was tested on X; if anything looks wrong, run /clean band". Never block.
- Add a `/clean doctor` command that prints the Claude Code version, the current mode, which render sites the mod has drawn this session, and any errors caught.

## Details

- **Name cleaner:** one pure function for every name. Strip absolute or multi-segment paths and backtick blocks longer than 20 characters, keep short identifiers, collapse whitespace, capitalise the first letter, trim to 50 characters at a word boundary with "…", fall back to "Working on it".
- **Animation:** none is required. A 1-second `$.clock.every` updates elapsed time only while a job is working or waiting; no timers while idle; cancel on `next.signal`.
- **Narrow terminals:** size the name column from `bodyColumns`; bars always 10 cells; rows never wrap; below 50 columns drop the step rows and show only header and progress.
- **Surveys:** if `hasSurvey`, pass through untouched.
- **Shared state** under the plugin's own key, typed in `types/index.d.ts`: `mode`, `checklist` (title, phase, tasks of `{ id, name, status: done|active|upcoming, startedAt, toolCalls }`, needsYouReason, stuckReason, startedAt, finishedAt, isCollapsed), `folded` (`{ files, searches, hosts, count }`), `errors`.
- **Structure:** `hooks/register.tsx` calls `registerCleanView(on)` from `clean-view.tsx`. All logic lives in `logic.ts` (cleaner, checklist reducer, fold rules, error-message mapping) with no `$` dependency. `clean-view.tsx` only wires events to the reducer and the reducer's state to drawing. Aim for under 400 lines total excluding tests.
- Add a short `README.md`: what it does, modes, the `nudgeTaskLists` option, `TESTED_VERSION`, how to load and install.

## Tests (`claude plugin test`)

1. Cleaner: "Refactor `src/middleware/auth/session.ts` handling" drops the path; "Fix `parseToken`" keeps the identifier; an 80-char name trims to ≤50.
2. A task list with one done and one active step renders ✓ / ▶ with time and tool count / Next / Up next and "Progress 1 of 4", on terminal and desktop.
3. A permission prompt shows **Needs you**.
4. Focus mode: a Read inside the repo is folded and its basename appears in the folded line; an Edit diff is visible; a failed Bash result is visible; a Read outside the repo is visible; a Read of `.env` is visible; an unknown tool is visible.
5. `/clean off` hides the band but keeps the button; `/clean calm` hides all tool rows.
6. With default config the mod registers no tools, adds no `prompt.compose` section and makes no `$.model` calls. With `nudgeTaskLists: true` the section appears.
7. A one-shot question with no tasks and no tool calls shows no band.
8. A render hook that throws falls back to the default drawing.
9. No tool call is ever denied by this mod.

## Done means

- Multi-step work shows a checklist within a second; quick questions don't.
- With default settings, token usage and Claude's behaviour are identical to running without the mod.
- Diffs, failures, out-of-repo reads and sensitive-file reads are always visible in focus mode; everything else folds into one line that names it.
- Permission prompts flip the header to **Needs you** immediately.
- The mode survives a restart. `claude plugin validate --strict` is clean and all tests pass.

When you're done, tell me how to switch modes, how to turn on the nudge, how to load it in the CLI and the Desktop app, and how to install it on another computer.

Before you start: read this whole prompt and the repo's `CLAUDE.md`. Then tell me in plain language what it will build, every file you will create or overwrite, and every command you will run. Wait for my yes before you begin.

Build a new Claude Code mod called **Pulse** in `moog-mods/pulse/`: a live, animated graph of what Claude is doing while it works, drawn in a pane beside the chat. It should look good and react to the mouse: hover to see what happened at a moment, click to pin it.

Same design rules as Clean View:
- **Observe, don't steer.** No tools, no system-prompt text, no model calls, no denied tool calls. It only watches events and draws.
- **Fail safe.** If the animated part fails, fall back to a plain text summary. Never break the session.
- **Small.** All logic in pure functions in `logic.ts`, tested.

Load the `plugin-authoring` skill if it's available and follow it. Otherwise use the types Claude Code writes to `.claude-plugin/types/` as the source of truth.

## How it draws (use this approach)

- The pane is opened with `$.ui.open({ id: 'pulse', title: 'Pulse' })` and drawn by a `ui.render` hook on `{ component: 'Pane', requestId: 'pulse' }`.
- The animated graph is a **`Client`** element (`module: './graph.tsx'`), which works in the terminal and the Desktop app. The hooks module passes it data through `props`; the client animates itself with `surface.every(...)`, handles the mouse with `surface.onPointer(...)` and keys with `surface.onKey(...)`, and reports clicks back with `surface.post(...)`, which arrives as `ui.message`.
- Rules the client must follow (from the types):
  - It draws only with `surface.elements` (`Box`, `Text`, `Button` and so on). No `Raster`, `Svg` or `Image` inside a `Client`, so build the graph from coloured `Text` using block and braille characters.
  - Start `surface.every` once, while `state` is still undefined. Only call `setState` in response to a tick, pointer, key or new props, never on every render, or it is unmounted as a render loop.
  - Keep each tree well under 20,000 nodes and 100,000 characters, and `props` under 100,000 characters. Send a compact summary, not the raw event log.
  - Each call must be fast. Do the heavy shaping in the hooks module or `logic.ts`, not in the client.
- Handle `ui.fault`: if the client fails, redraw the pane without it, showing the text summary instead.
- In the **VS Code** extension, where `Client` isn't drawn, show the text summary.

## What the pane shows

```
Pulse · Refactor auth middleware · 3m 41s · ● working
⠀⠀⢀⣀⣠⣴⣶⣦⣤⣀⡀⠀⠀⠀⢀⣤⣶⣿⣿⣶⣤⡀⠀⠀⠀⠀⣀⣤⣶⣦⣤⣀⠀⠀⠀
████████████▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░    step 2 of 4
 read ■  search ■  edit ■  run ■  fail ■           ↻ 14 calls/min
──────────────────────────────────────────────────────────────
 ▸ 0:42 ago  Edit  session.ts  (+12 −4)
```

1. **Header:** job name, elapsed time and a status dot that pulses while working, turns amber when Claude needs you, red when stuck, and green when done.
2. **Activity wave:** a scrolling graph of tool calls over time, one column per time bucket (about 5 seconds). Each column's height is the number of calls in that bucket, drawn with braille characters for smooth curves and coloured by the most common kind: read or search blue, edit green, run (Bash) amber, failed red. New data slides in from the right, and while Claude is thinking with no calls, a soft sweep moves along the baseline so it never looks frozen.
3. **Step bar:** a horizontal bar split into one segment per task-list step, each segment's width proportional to its time so far: done solid, active shaded and growing, upcoming dotted. Use the steps from TaskCreate, TaskUpdate or TodoWrite, or the approved plan. With no task list, show only the elapsed time.
4. **Legend and rate:** colour key, plus calls per minute over the last minute.
5. **Detail line:** what's under the mouse. Hovering a column shows the time, the calls in that bucket and the files touched. Hovering a step shows its name, duration and call count. Clicking pins the detail, and clicking again unpins it. With nothing hovered, it shows the most recent call.
6. **Keys** (once the graph has focus): ← and → move the selected column, Enter pins it, and Escape returns focus to the prompt.

**Animation:** about 10 frames a second while working or waiting on me, easing columns up to their new heights rather than jumping. When the job finishes, do one short "fill" animation of the step bar, then stop the clock. No timers while idle.

**Sizing:** fit `columns` and `rows` from the surface. At 40 columns or fewer, drop the legend and keep the wave and step bar. Rows never wrap.

## Opening it

- Add `/pulse` to toggle the pane, plus `/pulse doctor` to print the Claude Code version, whether the client is running and any errors caught.
- Remember in `$.store` whether the pane was open, and reopen it at `session.start` if so. Never open it unasked.
- Pulse draws only in its own pane. It must not touch `AbovePrompt` or tool rows, so it sits alongside Clean View without clashing.

## State

Keep it under the plugin's own key, typed in `types/index.d.ts`: `job` (title, phase, startedAt, finishedAt), `steps` (`{ id, name, status, startedAt, endedAt, calls }`), `buckets` (a ring buffer of the last 120 buckets, each `{ at, read, search, edit, run, fail, files: string[] }`, capped at 5 basenames each), `pinned` and `isPaneOpen`. Fill defaults for any missing field when reading.

## Tests (`claude plugin test`)

1. Bucketing: calls at 0s, 1s and 7s land in two buckets with the right counts and kinds.
2. Column heights scale so the tallest equals the available rows, and a bucket with no calls is height 0.
3. A failed call colours its bucket red, even if it holds more reads.
4. Step-bar segment widths are proportional to step durations and add up to the available width.
5. The ring buffer keeps only the last 120 buckets.
6. The pane on `terminal` and `desktop` contains a `Client`; on `vscode` it shows the text summary.
7. A `ui.fault` from the client makes the next render show the text summary.
8. A `ui.message` with a pinned column sets `pinned`, and a second one clears it.
9. Pulse registers no tools, adds no `prompt.compose` section, makes no `$.model` calls and denies no tool call.

## Done means

- `/pulse` opens a pane whose graph moves while Claude works, reacts to hover and click, and settles when the job ends.
- Add `pulse` to `.claude-plugin/marketplace.json`, version `0.1.0` in its `plugin.json`, an icon, and a short `README.md`, plus a row in the repo README's table.
- `claude plugin validate --strict ./pulse` passes and all tests pass. No commit or push unless I ask.

When you're done, tell me how to open it, what each part shows, which terminals give smooth mouse tracking, and anything that looks different in the Desktop app.
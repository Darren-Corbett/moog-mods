# Clean View

A checklist band above the Claude Code prompt showing the plan, the current step and real progress. Read-only tool noise (file reads, searches, lookups) folds into one line that still names what was touched. Edits, diffs, commands and failures stay visible.

```
Read the session handling · 1m 12s               [ Clean View: Focus ]
✓ Read the session handling                     Done
▶ Split token refresh into own fn               0:41 · 6 calls
○ Update callers                                Next
○ Run the test suite                            Up next
Progress 1 of 4  ███░░░░░░░
Folded: read auth.ts, session.ts, routes.ts +1 · searched "refreshToken" ×2   [ show ]
```

It only observes. With default settings it adds nothing to the system prompt, registers no tools, makes no model calls and never denies a tool call, so Claude behaves and costs exactly what it would without it.

The checklist comes from Claude's own task list (TaskCreate / TaskUpdate / TodoWrite) or from a plan you approve in plan mode. Without a task list the band shows the job name, elapsed time, tool-call count and the folded line. Quick questions with no tool calls show no band, just the mode button.

## Progress pane

`/clean pane` (or the band's `Pane` button) opens a live view of the job beside the chat; run it again to close it. If you leave it open, it reopens next session; it never opens on its own otherwise.

```
Refactor the auth middleware  Working  1m 50s

2 of 4 steps
██████████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░

✓ Read the session handling    ██████              0:38 · 5 calls
▶ Split token refresh          ████████▒▒          1:12 · 9 calls  ⚠ 1 failed
○ Update callers
○ Run the test suite

Edited token.ts
Read session.ts, routes.ts
Searched "refreshToken"
Last: Bash · npm test · 12s ago

Recent jobs
✓ Fix the flaky login test · 2m 14s · 3 steps
```

- **Header:** job name, phase (Working, Planning, Needs you, Stuck, Stopped, All done), total time.
- **Progress:** steps done out of total, or "No task list yet" with the tool-call count.
- **Timeline:** one row per step; each bar is the step's share of the time. The active bar grows live and ends in a lighter segment. ⚠ marks failed tool calls on the step they happened in; ‖ marks a step waiting on you.
- **Active step:** files edited (first, in the accent colour) and read, searches, and the last tool call.
- **Recent jobs:** the last 5 finished jobs (✓ done, ■ stopped, ⚠ stuck or errored), kept across restarts.

On Claude Code Desktop the timeline is drawn as an SVG Gantt chart; in the terminal and VS Code it is text. In off mode the pane just says how to turn Clean View back on.

## Modes

`/clean focus|band|calm|off`, `/clean` on its own to cycle, or click the mode button. The mode is remembered across restarts. `/clean help` prints one line per mode.

| Mode | What you see |
|---|---|
| focus (default) | Band on; reads and searches folded into one line; diffs, commands and failures visible. Bash output only when it failed. |
| band | Band on; every tool row as normal |
| calm | Band on; all tool rows hidden |
| off | Band hidden except the mode button |

Focus mode never folds a failed result, a read outside the working directory or repo, a sensitive-looking file (`.env*`, `.ssh/`, `*.pem`, `*key*`, `*secret*`, `*credential*`), or the read Claude based an edit on (shown as "read X before editing").

To get everything back: ctrl+o shows every row in full, and the band's `show` button unfolds the current turn.

`/clean doctor` prints the Claude Code version, the mode, which parts of the screen the mod has drawn and any errors it caught.

## Options

- `nudgeTaskLists` (default `false`): adds a short system-prompt section asking Claude to keep a 2 to 8 step task list for multi-step work. Costs a few dozen tokens per request. Set it in `/plugin` → clean-view → configure, or under `pluginConfigs` in settings.

## Compatibility

`TESTED_VERSION` in `clean-view.tsx` records the Claude Code version the mod was last tested on. On a newer version you get one toast. If anything looks wrong, run `/clean band` and check `/clean doctor`. Any error in a drawing hook falls back to Claude Code's own drawing.

## Load while developing

```
claude --plugin-dir ./clean-view              # hot-reloads on save
claude plugin validate --strict ./clean-view
claude plugin test ./clean-view
```

For the desktop app, set `CLAUDE_CODE_PLUGIN_DIRS` to the folder's absolute path.

## Install

```
/plugin install clean-view --marketplace Darren-Corbett/moog-mods
```

Answer `y` to add the marketplace, then pick a scope.

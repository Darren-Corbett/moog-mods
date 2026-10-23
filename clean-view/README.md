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

## Modes

`/clean focus|band|calm|off`, `/clean` on its own to cycle, or click the mode button. The mode is remembered across restarts.

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

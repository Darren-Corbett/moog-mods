# Clean View

A checklist band above the Claude Code prompt that shows the plan, the current step and real progress. Read-only tool noise (file reads, searches, lookups) is folded into one line that still names what was touched. Edits, diffs, commands and failures stay visible.

**Status:** placeholder. `hooks/register.tsx` only registers `/clean` and says the mod isn't built yet. Build it with `BUILD-PROMPT.md` (see the repo README).

## Install

```
/plugin install clean-view --marketplace OWNER/claude-mods
```

## Modes

`/clean focus|band|calm|off`, or `/clean` on its own to cycle. The mode is remembered across restarts.

| Mode | What you see |
|---|---|
| focus (default) | Band on; reads and searches folded; diffs, commands, failures, out-of-repo and sensitive-file reads visible |
| band | Band on; every tool row visible |
| calm | Band on; all tool rows hidden |
| off | Band hidden except the mode button |

`/clean doctor` prints the Claude Code version, the mode and any errors the mod caught.

## Options

- `nudgeTaskLists` (default `false`): when on, adds a short system-prompt section asking Claude to keep a task list for multi-step work. Off means the mod adds no tokens and doesn't change Claude's behaviour.

## Compatibility

`TESTED_VERSION` in the source records the Claude Code version the mod was last tested on. On a newer version you get one toast; if anything looks wrong, run `/clean band` and see `/clean doctor`.

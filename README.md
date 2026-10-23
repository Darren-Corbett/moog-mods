# My Claude Code mods

A plugin marketplace holding my Claude Code mods. Each mod lives in its own folder and is listed in `.claude-plugin/marketplace.json`.

| Mod | What it does | Status |
|---|---|---|
| [clean-view](clean-view/) | Checklist band above the prompt; folds read-only tool noise | Placeholder, build with `clean-view/BUILD-PROMPT.md` |

## Install on any computer

In a Claude Code terminal session:

```
/plugin install clean-view --marketplace OWNER/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it everywhere, including the desktop app's Code tab).

From a shell instead:

```
claude plugin install clean-view --marketplace OWNER/claude-mods
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** with `OWNER/claude-mods` → **Add plugin**.

If this repo is private, the machine needs a git credential for github.com first (an SSH key, or `gh auth login` then `gh auth setup-git`).

After pushing changes, pull them with `/plugin marketplace update my-mods`.

## Build Clean View

1. Clone this repo and `cd claude-mods/clean-view`.
2. Start `claude`, switch to plan mode (Shift+Tab), and paste the contents of `BUILD-PROMPT.md`.
3. Approve the plan. Claude replaces the placeholder `hooks/register.tsx` with the real mod and adds the tests.

## Develop a mod

```
claude --plugin-dir ./clean-view              # loads the folder, hot-reloads on save
claude plugin validate --strict ./clean-view  # what it hooks and calls, plus errors
claude plugin test ./clean-view               # runs *.test.ts / *.test.tsx
```

For the desktop app, set `CLAUDE_CODE_PLUGIN_DIRS` to the folder's absolute path (in your environment, or under `env` in `~/.claude/settings.json`).

## Add a new mod

1. Make a folder with `.claude-plugin/plugin.json`, `hooks/hooks.json` and `hooks/register.tsx`.
2. Add an entry to `.claude-plugin/marketplace.json` with `"source": "./<folder>"`.
3. Validate and test it, bump its `version`, commit and push.

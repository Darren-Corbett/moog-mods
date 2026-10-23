# moog-mods

This repo is a Claude Code plugin marketplace. Each top-level folder (other than `.claude-plugin`, `.github`) is one mod.

## Layout of a mod

- `.claude-plugin/plugin.json`: `name`, `version`, `description`, plus `"types": "./types/index.d.ts"` when the mod uses `$.state`
- `hooks/hooks.json`: `{ "modules": ["./register.tsx"] }`
- `hooks/register.tsx`: thin entry point that calls `register<ModName>(on)` from the mod's main file
- Pure logic in its own file with no `$` dependency, so it can be unit tested
- Tests named `*.test.ts` / `*.test.tsx`

Use the mod skill (`plugin-authoring`) when available. Otherwise treat the type definitions Claude Code writes into `<mod>/.claude-plugin/types/` as the source of truth for the API; they are generated, so don't commit or edit them.

## Rules

- Every mod must pass `claude plugin validate --strict <mod>` and `claude plugin test <mod>` before a commit.
- Bump the mod's `version` in `plugin.json` on any change people will install.
- Keep `.claude-plugin/marketplace.json` in sync: one entry per mod, `source` pointing at its folder.
- Mods fail safe: attach `.catch` to hooks, and a failing `ui.render` hook returns `next(e)`.
- No secrets in the repo. Use `userConfig` or environment variables.

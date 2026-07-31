---
kind: fixed
summary: `npm run lint` no longer fails just because a git worktree is open
---

ESLint linted `.worktree/<slug>/`, a nested checkout holding another branch's copy of the repo. The path-scoped config blocks resolve against the lint root, so a worktree copy of `scripts/verify-pack.mjs` never matched `scripts/**/*.mjs`, fell through to a config with no Node globals, and every `console`/`process` reference became `no-undef` — 8 errors from files that are not this working tree's source. Because `verify` starts with `lint`, anyone with a worktree open could not run the battery at all. `.worktree/**` is now ignored.

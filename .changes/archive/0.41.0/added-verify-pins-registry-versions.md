---
kind: added
summary: verify-pins checks exact @andrewpopov/* registry versions and can forbid new github pins
---

An `@andrewpopov/*` dependency whose spec is an exact semver (`"0.1.7"`; no range operator, no `npm:` alias) is now a pin: the installed `node_modules/<name>/package.json` version is compared like a `github:` tag pin, with the same `ok` / `MISMATCH` / `missing` / `corrupt` statuses (the fix line is `npm install <name>@<version> --save-exact`). Ranges, other scopes, `file:` and `workspace:` are unchanged.

New opt-in `forbidGithubScope` (config key, and `deploy-kit verify-pins --forbid-github-scope @andrewpopov`): any `github:andrewpopov/...` or bare `andrewpopov/...#ref` dependency then fails as `FORBIDDEN`, with the fix "pin the exact registry version". Off by default; a migrated repo sets `"forbidGithubScope": "@andrewpopov"` in `.deploy-kit.config.json` so the deploy gate enforces it on the target. The shipped `pin-gate` program stays `fs`/`path` only.

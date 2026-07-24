# deploy-kit Maturation Spec — retired

This document was a v0.4.0-era roadmap (`src/` = 691 lines, 25 tests, 5
adopters) tracking deploy-kit's path to a stable v1.0: config validation,
locking, ssh timeouts, rollback, dry-run, `healthChecks`, `deploy-kit init`,
prefer-offline install, a `tsc` contract check for `index.d.ts`, and more.

**Retired as of v0.14.0.** An audit (PKG-82) verified nearly the entire
"Missing" / P0 / P1 list against the current source: it is done. Roadmap and
backlog tracking for this package now live in **Cairn** (project `PKG`), not
in a repo file — see `~/proj/CLAUDE.md` on roadmaps-in-Cairn. This file is
kept only as a pointer; do not add new roadmap items here.

## What the audit found done (verified against source, not taken on faith)

- **Config validation** — `src/config.js`: `validateConfig`/`loadConfig` reject
  unknown keys, wrong types, and `REMOVED_KEYS` (e.g. `ensureTunnelOnDeploy`)
  with a migration hint.
- **SSH timeouts** — `src/exec.js` applies `ConnectTimeout`/`ServerAliveInterval`/
  `ServerAliveCountMax` plus a per-step `stepTimeoutSeconds` (default `1800`,
  not the old unbounded default).
- **Concurrent-deploy lock** — `src/lock.js`: atomic lock under
  `$HOME/.deploy-kit`, PID+TTL staleness, `--steal-lock` escape hatch.
- **Rollback** — `deploy-kit rollback` in `src/cli.js`/`src/deploy.js`.
- **Dry-run** — `--dry-run` wired through the injectable runtime seam, rejected
  on commands that don't consume it (`stop --dry-run` etc.).
- **`healthChecks` (multi-endpoint)** — `src/config.js`/`src/deploy.js`:
  array of `{ port?, path?, headers? }` gates, scalar fields kept as sugar.
- **`deploy-kit init`** — scaffold command in `src/cli.js`/`src/init.js`.
- **Prefer-offline install** — `DEFAULT_CONFIG.hooks.install` is
  `'npm ci --prefer-offline || npm ci || npm install'`.
- **`tsc` contract check** — `npm run verify:types` (`tsc --noEmit -p
  tsconfig.types.json`), wired into `.github/workflows/ci.yml`.
- **Dead `--force` flag** — removed entirely, not just documented away.
- **Stash accumulation** — the deploy drops its own marked stash after a
  successful pull (`src/deploy.js`).
- **Test coverage** — `cli.js`, `tunnel.js`, and `remote.js`/host-operations
  verbs, local-mode end-to-end, `loadConfig` error paths, and `waitForHealth`
  retries all have dedicated `describe` blocks under `src/__tests__/`.
- **Node 22/24 matrix** — non-required `compat` job feeding a `ci-success`
  aggregation gate, so a matrix rename can't silently drop the required
  `test` context.
- **Docs** — README now has a full config reference, CLI reference, `mode:
  local`, release-layout, monitoring, and troubleshooting sections.
- **Release tagging** — superseded by adopting `release-kit`
  (fragment-based `CHANGELOG.md` + version bump), rather than the
  hand-written `release:tag` script this document originally proposed.

## Still genuinely open

- **Docker sshd integration test.** No fixture-host / container-based
  end-to-end test exists in this repo or its CI. The unit tests fake
  `execFileSync` and can't see quoting bugs in the composed
  `ssh host "cd dir && …"` string — the exact class of bug this PKG-82 audit
  pass fixed by hand (branch/remote shell-quoting). A Docker container running
  sshd + pm2 + a trivial app, exercised by a real `deploy-kit deploy` in ssh
  mode against `localhost`, is the only way to catch that class end-to-end.
  Recommended: a separate, non-required CI job first; promote to required
  once stable. Tracked in Cairn project `PKG`.
- **Fleet tag convergence.** Whether all adopters (bewks, smarthome, stoki,
  sano-os, kira) are on the same deploy-kit tag is a fleet-wide fact that
  can't be verified from this repo alone — not re-checked as part of this
  audit.

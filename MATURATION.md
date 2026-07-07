# deploy-kit Maturation Spec (v0.4.0 → v1.0)

A concrete roadmap for maturing `@andrewpopov/deploy-kit` from its current state
to a stable v1.0. Grounded in the code as of v0.4.0 (`src/` = 691 lines of plain
JS, 25 unit tests, 7 published tags, 5 adopters).

## 1. Current maturity

**Version:** 0.4.0. Seven immutable tags (`v0.1.0`–`v0.4.0`), each with a
CHANGELOG entry; release-guard CI asserts tag/version/CHANGELOG agreement.
Already had one breaking change (v0.4.0 replaced `ensureTunnelOnDeploy` with
`ensureApps`) handled with a documented migration — good semver hygiene pre-1.0.

**Solid:**
- The pipeline core (`src/deploy.js`) faithfully preserves the safety behavior
  of the hand-rolled `deploy.sh`s: backup-gates-migrate, resume-paused-apps on
  any post-stop failure, `--ff-only` pull, tracked-only stash, health-gate.
- Testability is designed in: the `runtime.execFileSync` seam (`src/exec.js`)
  lets tests assert the exact command stream without ssh/pm2. 25 tests cover
  step ordering, all three abort/resume paths, `buildBeforeMigrate`,
  `ecosystemFile`, `ensureApps` tolerance, and `preDeployChecks` gating.
- CI runs unit tests + `verify:pack` (consumer-side tarball install smoke) on
  every PR; branch protection per STANDARDS.md.
- Real adopters: bewks (`#v0.2.1`), smarthome (`#v0.3.1`), stoki (`#v0.3.1`),
  sano-os (`#v0.4.0`), kira. Every feature since 0.2.0 came from a real
  adoption need (stoki's `healthHeaders`, sano's `ecosystemFile`/local mode).

**Missing:** config validation (typos are silently ignored), CLI/tunnel/remote
test coverage, a complete config reference (README documents ~10 of 16 options),
rollback, dry-run, deploy locking, ssh timeouts, and fleet version convergence
(bewks is two minor versions behind).

## 2. Testing

Unit coverage is strong for `deploy.js` but thin elsewhere. Concrete gaps:

- **`cli.js` — zero tests.** `parseOptions` (flag parsing, `--lines N`
  arity), `run()` exit codes, unknown-command path, and help output are all
  untested. These are pure functions with an injectable cwd; cheap wins.
- **`tunnel.js` — zero tests.** The three throw paths (missing `configPath`,
  missing `tunnelName`, config file not found) and the composed cloudflared
  argv are testable with the existing `ctx.execFileSync`/`ctx.fs` seams.
- **`remote.js` — only `restart` and `health` tested.** Untested: `logs`
  (the `--err`/`--follow`/`--lines` command composition), `lifecycle` with
  empty `appNames` (error path), `allApps` dedup with `ensureApps` +
  `tunnelName`, `dashboard`/`resources`/`gitInfo`.
- **Config permutations:** `mode: 'local'` deploy end-to-end (stash skipped,
  `sh -c` wrapping) is only tested at the `buildTargetCommand` level, not
  through `deploy()`. `loadConfig` malformed-JSON throw and file-present merge
  are untested. `resolveBranch`'s `origin/HEAD` fallback chain is untested.
- **Failure modes:** `waitForHealth` retry counting (fail N then 200),
  non-numeric curl output, and the `stash` tolerate path.
- **Discovered dead code:** `--force` is parsed by the CLI and destructured in
  `deploy()` but used nowhere. Either implement (force non-ff pull?) or delete
  before 1.0 — an option that parses but does nothing is a trap.
- **Integration:** no fixture-host test. Add one Docker-based smoke in CI
  (a container with sshd + pm2 + a trivial express app + a git repo) that runs
  `deploy-kit deploy` for real in ssh mode against `localhost`. This is the
  only way to catch quoting bugs in the composed `ssh host "cd dir && …"`
  strings that the fake-exec tests can't see. Run it as a separate non-required
  CI job first; promote to required once stable.

## 3. Docs & DX

- **Config reference:** README documents the options narratively but not
  completely. `healthHeaders`, `health.attempts`/`delaySeconds`, `remote`,
  `port`/`healthPath` defaults, and especially **`hooks.restart`** (read in
  `deploy.js:179`, declared in `index.d.ts`, absent from `DEFAULT_CONFIG` and
  the README) are undocumented or under-documented. Add a table: every key,
  type, default, which mode(s) it applies to, and the version it appeared in.
- **Stale install line:** README says `npm install github:andrewpopov/deploy-kit#v0.1.0`.
  Point it at the latest tag (or say "pin the latest `vX.Y.Z` tag").
- **CLI reference:** the `logs` flags (`--lines/--follow/--errors`) and
  `--no-stash` exist only in `--help`. Document all verbs + flags in README.
- **Troubleshooting section:** the knowledge exists but lives in CHANGELOG
  prose — e.g. "health probe returns 301 → set `healthHeaders`
  X-Forwarded-Proto" (0.3.1), "first deploy of a new process needs
  `ecosystemFile`" (0.3.0). Lift these into a Troubleshooting section.
- **Per-adopter examples:** the README shows a generic ssh config and sano's
  local config. Add a short `examples/` dir (or README appendix) with the
  real shapes: bewks (ssh + worker in `dbBoundApps`), stoki
  (`buildBeforeMigrate` + `healthHeaders`), sano (local + `ensureApps` +
  `preDeployChecks`). Adopter configs are the best onboarding doc.

## 4. API/config stability & v1.0 criteria

Call it 1.0 when all of the following are true:

1. **Config schema validation.** Today `mergeConfig` spreads unknown keys
   silently — a consumer still setting v0.3.0's removed `ensureTunnelOnDeploy`
   gets no warning and no tunnel-ensure. Validate on `loadConfig`: reject (or
   loudly warn on) unknown keys, wrong types, and known-removed keys with a
   migration hint. ~50 lines by hand; no dep needed (STANDARDS.md: near-zero
   runtime deps).
2. **No dead surface.** Remove or implement `--force`; add `hooks.restart` to
   `DEFAULT_CONFIG` + README or remove it from `deploy.js`/`index.d.ts`.
3. **`index.d.ts` is contract-tested.** Add a `tsc --noEmit` check in CI over a
   small consumer snippet so the hand-written types can't drift from the JS.
4. **Deprecation policy written down** (in STANDARDS.md or README): a config
   key removal ships one minor version as a warned deprecation before the
   breaking major; CHANGELOG entry must include the migration.
5. **Fleet is converged on one tag.** bewks (`v0.2.1`) is missing the 0.3.x/0.4.0
   fixes; converge all five adopters on the 1.0 tag as the release act.

## 5. Release/CI hardening

- **Keep:** verify-pack, release-guard, branch protection, immutable tags —
  all working as designed.
- **Node matrix:** CI runs only Node 20 (the engines floor). Add Node 22/24 via
  a `ci-success` aggregation job (the ci.yml comment already prescribes exactly
  this to avoid breaking the required `test` context). The Pi fleet will cross
  Node versions eventually; catch it in CI, not on the Pi.
- **The Pi offline-install failure mode is unaddressed.** STANDARDS.md ("The Pi
  deploy failure mode") says deploy-kit must prefer lockfile/offline-cache
  installs so a GitHub outage can't break a no-dep-change deploy — but the
  default install hook is plain `npm ci || npm install`, which resolves
  `github:` deps over the network. Change the default to
  `npm ci --prefer-offline || npm ci || npm install` and document the tradeoff.
- **Tag automation:** the release checklist is manual (bump + CHANGELOG in PR,
  then hand-tag the merge commit). A tiny `npm run release:tag` script that
  reads package.json and tags/pushes would remove the one step release-guard
  can only catch after the fact.

## 6. Robustness / feature gaps

Observed in `src/`, roughly ordered by risk:

- **No ssh timeout.** `runOnTarget` uses `execFileSync` with no `timeout` and
  no `ConnectTimeout` ssh option — a wedged Tailscale route hangs the deploy
  forever, mid-pipeline, possibly with db-bound apps paused. Add
  `-o ConnectTimeout=10 -o ServerAliveInterval=15` to the ssh argv and a
  configurable per-step timeout.
- **No concurrent-deploy lock.** Two `deploy-kit deploy` runs against the same
  target interleave pm2 stop/start and git pulls. Take a lockfile on the target
  (`mkdir /tmp/deploy-kit-<app>.lock` as the atomic primitive) as step 0,
  release on exit/abort, `--steal-lock` escape hatch.
- **No rollback.** The pieces already exist: the pre-migrate backup, and git.
  Record the pre-pull SHA (already fetched in `resolveBranch`'s neighborhood),
  and add `deploy-kit rollback` = `git reset --hard <recorded SHA>` + rebuild +
  restart, printing the matching `db-backup restore` command rather than
  auto-restoring data.
- **Dry-run.** `--dry-run` that prints the exact command stream without
  executing is nearly free given the `runtime` seam (inject a printing
  execFileSync) and doubles as living documentation of what a deploy does.
- **Stash accumulation.** The deploy `git stash push`es tracked changes and
  never pops or drops — stashes pile up on the target forever. Either drop the
  stash after a successful pull or warn with a count.
- **Health-gate covers only one port.** bewks runs app + worker but only the
  web app's `/api/health` is gated; a crash-looping worker deploys "green".
  Consider `healthChecks: [{ port, path, headers }]` (array), keeping the
  scalar fields as sugar.
- **Quoting edges:** `buildHealthCommand` wraps header values in single quotes
  with no escaping, and `projectDir` is interpolated raw into `cd <dir> &&`.
  Fine for trusted config, but validate (reject `'` in header values, require
  absolute `projectDir`) so a config typo fails fast instead of weirdly.

## 7. Adoption

- **Adopters:** bewks `v0.2.1`, smarthome `v0.3.1`, stoki `v0.3.1`, sano-os
  `v0.4.0`, kira. All five hand-rolled `deploy.sh`s are retired (BWK-86).
- **Friction observed:** version skew (nobody bumps until they need a feature);
  every adopter re-invents the same `package.json` script block
  (`"deploy": "deploy-kit deploy"`, `remote:*` — compare bewks/smarthome/stoki,
  near-identical); no scaffold for a new service.
- **Make adoption trivial:** add `deploy-kit init` — writes a commented
  `.deploy-kit.config.json` skeleton and prints the recommended `package.json`
  scripts block. Pair with the config validation so `init` + fill-in-blanks +
  `deploy-kit deploy --dry-run` is the entire onboarding.

## Prioritized next actions

**P0 — correctness/safety, do before any new features**
1. Add ssh `ConnectTimeout`/`ServerAliveInterval` + per-step timeout to
   `runOnTarget` (hang with apps paused is the worst current failure mode).
2. Config validation in `loadConfig`: unknown/removed keys warn or reject
   (catches the silent `ensureTunnelOnDeploy` migration trap).
3. Remove dead `--force`; document or remove `hooks.restart`; fix the stale
   `#v0.1.0` install line in README.
4. Concurrent-deploy lock on the target.

**P1 — confidence and DX**
5. Tests for `cli.js`, `tunnel.js`, remaining `remote.js` verbs, local-mode
   `deploy()` end-to-end, `loadConfig` error path, `waitForHealth` retries.
6. `--dry-run` (printing runtime injection) + `deploy-kit init` scaffold.
7. Full config reference table + troubleshooting section + per-adopter
   example configs in README.
8. `tsc --noEmit` contract check for `index.d.ts` in CI; Node 22/24 matrix
   behind a `ci-success` aggregation job.
9. Default install hook → `npm ci --prefer-offline || npm ci || npm install`
   (the STANDARDS.md Pi offline requirement).

**P2 — 1.0 and beyond**
10. `deploy-kit rollback` (git reset to recorded SHA + rebuild + restart).
11. Multi-endpoint health checks (`healthChecks` array) for app+worker fleets.
12. Docker fixture-host integration test in CI (non-required job first).
13. Converge all adopters on one tag, write the deprecation policy, ship
    v1.0.0, and bump the fleet in the same pass.

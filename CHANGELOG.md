# Changelog

<!--
Add a new entry at the top under `## <next-version>` when you change shipped
behavior. The release-guard CI job asserts the git tag `vX.Y.Z` matches
package.json and that a `## X.Y.Z` heading exists here. Tags are immutable —
fix forward with a new patch version.
-->

## 0.7.0

Artifact-first release-layout deploys (SMH-112). Opt-in; every existing app is
untouched until it adds a `layout` block.

- **New — `layout: { type: 'releases', … }` (opt-in).** Switches an app from the
  legacy in-place deploy (which runs `npm ci` + build **on the live worktree**,
  the cause of smarthome's repeated `@prisma/client did not initialize yet`
  crash-storms) to a Capistrano-style release layout. Each deploy materialises an
  immutable release under `releases/<sha>-<ts>` from a **bare repo + detached
  worktree**, installs and builds **inside that release** while the old `current`
  keeps serving, validates it, and only then opens the disruptive window: stop
  writers → backup → migrate → **atomic `current` symlink flip** (`mv -Tf`, a
  namespace-atomic rename on ext4) → restart from a stable PM2 ecosystem. `npm ci`
  and build never mutate the tree the live process runs from.
- **Activation is verified, not assumed.** A deploy only succeeds when the health
  endpoint returns 200, **every** managed PID's `/proc/<pid>/cwd` resolves to the
  new release, the running app reports the deployed SHA (`layout.runningShaCommand`),
  PM2 shows every app online, and restart counts stay flat across a settling
  window — so an old process answering 200 can't mask a failed flip.
- **DB-aware recovery state machine.** Recovery is phase-specific: a failed
  install/build/validate just quarantines the candidate (current never touched);
  a failure after the schema changed **stops and confirms all DB writers are down**,
  restores the pre-migration backup (`hooks.restore`, given `DEPLOY_KIT_BACKUP_ID`)
  and resumes the previous release — or aborts with a loud `MANUAL RECOVERY REQUIRED`
  and the backup id rather than resuming stale code on a new schema. `SIGINT`/`SIGTERM`
  run the same machine, and each disruptive phase is **durably journaled**
  (atomic write) to `.deploy-kit-state.json` before the irreversible step, so a
  process/SSH/power loss leaves an on-host record of what needs restoring. The
  next deploy **refuses to start** if it finds an un-recovered interrupted phase
  (loud "resolve by hand"); a successful recovery clears that state.
- **The writer stop is gated and verified** (a zero-exit `pm2 stop` is not proof —
  the backup only runs once every `dbBoundApp` is confirmed not-online), the
  disruptive window refuses to open without a validated known-good `current`
  pointer to fall back to, and `rollback` flips back to the running release if its
  target comes up unhealthy.
- **`rollback` under `layout`** is an instant symlink flip to the `previous`
  release (already built — no reinstall/rebuild), with a warning that a schema
  rollback is a separate, explicit data-loss decision.
- **Safety rails.** Release deploy refuses a host with no completed layout marker
  (`.deploy-kit-layout`, versioned) and never restructures a live root; a legacy
  deploy/rollback refuses a host that **is** on the release layout; `sharedPaths`
  are validated relative/non-overlapping and rejected if they'd hide a tracked
  file; a free-disk and GNU-`mv` preflight fails closed. Explicit release metadata
  (`.deploy-kit-state.json`) and pruning that only ever touches `releases/` and
  never removes `current`/`previous`.
- **New — `hooks.restore`** (nullable): restore the pre-migration DB backup during
  release-layout recovery. `null` = no auto-restore.

The one-time host migration (restructuring `/srv/<app>` into
`releases/`+`shared/`+`current`) is a separate, explicit, reversible operation per
app — deploy-kit does not perform it. smarthome is the pilot.

## 0.6.1

**Fix — an unknown flag was silently ignored. A typo could run a real production
deploy.**

`parseOptions` matched the flags it knew and dropped everything else on the
floor. That is dangerous for exactly the flag an operator reaches for when being
careful: a typo'd `--dry-rn`, or `--dry-run` passed to a version that predates
it, ran a **full production deploy** while the operator believed nothing would
happen.

This is not hypothetical. On 2026-07-10 a checkout whose `node_modules` held
0.3.1 while its manifest pinned v0.6.0 (see BRAIN-18: `npm install` never
re-resolves a `github:` tag) ran `deploy-kit deploy --dry-run` and deployed for
real. Two failures compounded: an unknown flag was ignored, and a **safety** flag
that did not exist in the installed version degraded to the **unsafe** behaviour.

- Any unrecognised argument now throws, naming the valid options. This includes
  the long-removed `--force`, which was previously ignored — the same treatment a
  removed *config* key already gets.
- A bad argument prints like an unknown command and exits 1, rather than dumping
  a stack trace.
- Every real run now logs `deploy-kit v<version>` first, so a stale install is
  visible in the deploy log instead of only surfacing when a flag misbehaves.

## 0.6.0

Conformance with the shared package standards
(`agent_tools/knowledge/shared-package-standards.md`), standard 3: **a timeout
that defaults to off is not a bound.**

- **Fix — `stepTimeoutSeconds` now defaults to 1800 (30 minutes) instead of
  `null`.** `src/exec.js` applied a process timeout only when the key was set,
  and none of the five consumers (cairn, savoro, smarthome, bewks, sano-os) set
  it. Every deploy step — `npm ci`, build, `prisma migrate`, `pm2 restart`, the
  health probe — ran unbounded on the Pi, directly beneath the code comment
  *"Kill a hung remote command instead of blocking the pipeline forever."*

  The harm is worse than a slow deploy: `deploy()` takes an atomic lock for the
  whole pipeline, so a step that never returns holds that lock forever and blocks
  every **subsequent** deploy until someone runs `--steal-lock`.

  30 minutes per step is deliberately generous — `npm ci` and a Next.js build on
  a Raspberry Pi are legitimately slow, and a bound nobody can hit is a bound
  nobody disables. Consumers can tighten it, or set `stepTimeoutSeconds: null` to
  opt out entirely.
- A killed step now uses `killSignal: 'SIGKILL'` and reports the step and the
  bound rather than a bare `ETIMEDOUT`.
- `src/tunnel.js` is documented as the deliberate exception: that `execFileSync`
  **is** the long-running `cloudflared tunnel run` process, so bounding it would
  kill the tunnel it just started.

## 0.5.0

Maturation hardening (MATURATION.md P0/P1 + selected P2).

- **ssh hardening (safety):** every `ssh` invocation now carries
  `-o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3`
  (configurable via `ssh: {}`, each opt-out with `null`) so a wedged Tailscale
  route can't hang a deploy forever with db-bound apps paused. New
  `stepTimeoutSeconds` (default null) kills a hung remote command.
- **Config validation:** `loadConfig` now rejects unknown keys, wrong types, a
  bad `mode`, and known-removed keys (e.g. `ensureTunnelOnDeploy`) with a
  migration hint — no more silent no-ops. `strict:false` warns instead of
  throwing; `validate:false` skips. Exposes `validateConfig`.
- **Concurrent-deploy lock:** an atomic `mkdir /tmp/deploy-kit-<id>.lock` guards
  the pipeline (released on exit/abort). `config.lock:false` or `--no-lock`
  disables; `--steal-lock` forces past a held lock.
- **`deploy-kit rollback`:** each deploy records the pre-pull SHA to
  `.deploy-kit-prev-sha`; rollback does `git reset --hard <sha>` + rebuild +
  restart + health-gate, and prints the matching db-backup restore hint (data is
  never auto-restored).
- **`deploy-kit init`:** scaffolds a `.deploy-kit.config.json` skeleton and
  prints the recommended `package.json` scripts block.
- **`--dry-run`:** prints the exact command stream without executing.
- **Multi-endpoint health:** `healthChecks: [{ port, path, headers }]` gates
  app+worker fleets; the scalar `port`/`healthPath` stays as sugar.
- **Stash no longer accumulates:** the deploy-kit tracked-change stash is dropped
  after a successful pull (only ever a deploy-kit stash).
- **Offline-first install (STANDARDS.md Pi failure mode):** default `hooks.install`
  is now `npm ci --prefer-offline || npm ci || npm install`.
- **`hooks.restart`** is now in `DEFAULT_CONFIG` and documented (was read but
  undeclared). Removed the dead `--force` flag.
- **Fail-fast on bad health headers:** a single quote in a `healthHeaders` value
  (which would break curl quoting) now throws instead of emitting a broken probe.
- **Docs:** full config + CLI reference tables, a Troubleshooting section, and
  per-adopter example configs; fixed the stale `#v0.1.0` install line.
- **CI:** `verify:types` (`tsc --noEmit` contract check for `index.d.ts`), a
  Node 22/24 `compat` matrix, and a `ci-success` aggregation job. `test` stays
  the required context name.

## 0.4.0

- **BREAKING:** replace tunnel-specific `ensureTunnelOnDeploy` (v0.3.0) with generic
  **`ensureApps: string[]`** — auxiliary PM2 processes ensured up (tolerant,
  start-or-restart via `ecosystemFile`) AFTER the main `appNames` restart. A tunnel
  is just one entry; the pipeline no longer hardcodes "tunnel". Migration: replace
  `"ensureTunnelOnDeploy": true` + reliance on `tunnelName` with
  `"ensureApps": ["<your-tunnel>"]`. `tunnelName` remains for ops-verb display.
  The deploy step label changes from `tunnel` to `ensure`.
- Add **`preDeployChecks: [{ name, command }]`** — user-defined gates run BEFORE
  anything is touched (no stash/fetch/pull yet). A non-zero exit aborts the deploy
  with nothing changed. For preconditions: free disk, DB reachable, required secret
  present. The kit runs them; the consumer supplies them. Adds `check:<name>` steps.
- `remote.allApps` now includes `ensureApps` (deduped) alongside `appNames`/`tunnelName`.

## 0.3.1

- Add `healthHeaders` config (default `{}`) — extra headers on the health probe,
  applied by both the deploy health-gate and the `remote health` verb. Needed for
  apps that force-redirect plain http to https behind a TLS-terminating proxy: a
  direct localhost curl gets a 301, but `{ "X-Forwarded-Proto": "https" }` makes
  them serve the real 200 (found adopting stoki). Exposes `buildHealthCommand(config)`.

## 0.3.0

- Add `ecosystemFile` (config, default null). When set, the deploy (re)starts
  apps via `pm2 start <file> --only <name> 2>/dev/null || pm2 restart <name>`
  instead of a bare `pm2 restart`, so a not-yet-registered process starts on the
  first deploy and a running one restarts. Null preserves the old
  `pm2 restart <appNames>` (bewks/kira/smarthome/stoki unaffected).
- Add `ensureTunnelOnDeploy` (config, default false). When true and `tunnelName`
  is set, the cloudflared tunnel is brought up at the end of a deploy (start-or-
  restart when `ecosystemFile` is set), tolerant of failure so a tunnel hiccup
  never fails an otherwise-healthy deploy. Adds a `tunnel` step between `restart`
  and `health`. Folds sano's hand-rolled deploy.sh tunnel-ensure tail into the kit.

## 0.2.1

- Renamed package scope `@andrewvpopov/*` -> `@andrewpopov/*` after consolidating the GitHub org into the `andrewpopov` user. No runtime or API change; update imports and the `github:` install path to `andrewpopov/deploy-kit`.

## 0.2.0

- Add `buildBeforeMigrate` (config or option, default false). When true, the build
  runs while the apps are still up — before the backup/stop/migrate block — so the
  app-paused window is just the migration, not migration + build. Repos that build
  first and stop only for the DB work (e.g. stoki) use this to avoid extra downtime.
  A build failure in this mode aborts before anything is stopped. Default (false)
  preserves the existing build-while-paused order (bewks/kira unaffected).

## 0.1.1

- Safety fix: once the DB-bound apps are paused for migration, a failure in
  ANY later step (now including **build**, not just migrate) resumes them via
  `pm2 start` before aborting. Previously a build failure left the paused apps
  stopped — production down. Matches deploy.sh, which resumes on every post-stop
  failure. Recovery now uses `pm2 start` (the apps are stopped) rather than
  `pm2 restart`.

## 0.1.0

Initial extraction (BWK-86) — generalizes the deploy/ops tooling that was
copy-pasted across bewks/kira/smarthome/stoki/sano into one hook-driven kit.

- `deploy(config, options, ctx)` — the pipeline, faithful to the hand-rolled
  `deploy.sh` step order: stash (tracked-only) → fetch → pull `--ff-only` →
  install → **backup gate (aborts before any schema change)** → stop DB-bound
  PM2 apps (release the SQLite lock) → migrate (restarts paused apps + aborts on
  failure) → build → restart apps → **health-gate**. Framework variance is
  isolated to 4 config hooks: `install`/`backup`/`migrate`/`build`.
- `mode: 'ssh' | 'local'` — `ssh` deploys from a laptop; `local` runs on the box
  (sano's model, no SSH).
- `remote` ops CLI — `status/health/dashboard/resources/git/logs/start/stop/
  restart`, generalized from bewks `remote-agent.js`, driven by PM2 app names.
- `startTunnel({ configPath, tunnelName })` — Cloudflare tunnel launcher.
- `deploy-kit` bin + `.deploy-kit.config.json` config file.
- Consumers pair this with `@andrewpopov/db-backup` by pointing `hooks.backup`
  at a db-backup CLI invocation.

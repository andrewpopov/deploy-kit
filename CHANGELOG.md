# Changelog

<!--
Add a new entry at the top under `## <next-version>` when you change shipped
behavior. The release-guard CI job asserts the git tag `vX.Y.Z` matches
package.json and that a `## X.Y.Z` heading exists here. Tags are immutable —
fix forward with a new patch version.
-->

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

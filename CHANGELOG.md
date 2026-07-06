# Changelog

<!--
Add a new entry at the top under `## <next-version>` when you change shipped
behavior. The release-guard CI job asserts the git tag `vX.Y.Z` matches
package.json and that a `## X.Y.Z` heading exists here. Tags are immutable —
fix forward with a new patch version.
-->

## 0.3.0

- Add `healthHeaders` config (default `{}`) — extra headers on the health probe,
  applied by both the deploy health-gate and the `remote health` verb. Needed for
  apps that force-redirect plain http to https behind a TLS-terminating proxy: a
  direct localhost curl gets a 301, but `{ "X-Forwarded-Proto": "https" }` makes
  them serve the real 200. Exposes `buildHealthCommand(config)`.

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
- Consumers pair this with `@andrewvpopov/db-backup` by pointing `hooks.backup`
  at a db-backup CLI invocation.

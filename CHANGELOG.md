# Changelog

<!--
Add a new entry at the top under `## <next-version>` when you change shipped
behavior. The release-guard CI job asserts the git tag `vX.Y.Z` matches
package.json and that a `## X.Y.Z` heading exists here. Tags are immutable —
fix forward with a new patch version.
-->

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

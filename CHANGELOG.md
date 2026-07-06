# Changelog

<!--
Add a new entry at the top under `## <next-version>` when you change shipped
behavior. The release-guard CI job asserts the git tag `vX.Y.Z` matches
package.json and that a `## X.Y.Z` heading exists here. Tags are immutable —
fix forward with a new patch version.
-->

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

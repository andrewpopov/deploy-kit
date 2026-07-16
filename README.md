# @andrewpopov/deploy-kit

Hook-driven deploy pipeline, remote PM2 ops CLI, and Cloudflare tunnel launcher
for self-hosted Node services — apps that run under PM2 on a single box (a
Raspberry Pi, a home server, a small VPS) and deploy by `git pull`. One JSON
config per app replaces a hand-rolled `deploy.sh`: the kit runs
stash → pull → install → backup → migrate → build → restart → health-gate, with
the safety behavior those scripts usually lack (the backup gates the migration,
paused apps are resumed on any failure, deploys are locked and health-verified).

## Install

Pin the latest tag (tags are immutable — always pin `vX.Y.Z`, never a branch):

```
npm install github:andrewpopov/deploy-kit#v0.12.0
```

## Quick start

```
npx deploy-kit init          # scaffold .deploy-kit.config.json + scripts block
# edit the config for your app…
npx deploy-kit deploy --dry-run   # print the exact command stream, run nothing
npx deploy-kit deploy             # run it for real
```

## Configure

Drop a `.deploy-kit.config.json` in the repo root (or run `deploy-kit init`):

```json
{
  "host": "youruser@your-tailscale-host",
  "projectDir": "/srv/yourapp",
  "mode": "ssh",
  "appNames": ["yourapp-app", "yourapp-worker"],
  "dbBoundApps": ["yourapp-app", "yourapp-worker"],
  "tunnelName": "yourapp-tunnel",
  "port": 3000,
  "healthPath": "/api/health",
  "hooks": {
    "install": "npm ci --prefer-offline || npm ci || npm install",
    "backup": "npx db-backup backup --prod --allow-missing",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

## Project policies

See [Contributing](./CONTRIBUTING.md), [Support](./SUPPORT.md), and the
[Security Policy](./SECURITY.md). This package is licensed under [MIT](./LICENSE).

The `.deploy-kit.config.json` holding your real host/paths lives in each
**consumer** repo, never in this package. The config is validated on load —
unknown keys, wrong types, a bad `mode`, or a removed key (e.g.
`ensureTunnelOnDeploy`) fail with a clear error instead of a silent no-op.

### Config reference

| Key | Type | Default | Mode | Since | Notes |
| --- | --- | --- | --- | --- | --- |
| `host` | `string \| null` | `null` | ssh | 0.1 | `user@host`; required for `mode:'ssh'`. |
| `projectDir` | `string \| null` | `null` | both | 0.1 | Absolute path on the target; `cd`-ed into per step. |
| `mode` | `'ssh' \| 'local'` | `'ssh'` | — | 0.1 | `ssh` = deploy from laptop; `local` = script runs on the box. |
| `remote` | `string` | `'origin'` | both | 0.1 | Git remote to fetch/pull. |
| `branch` | `string \| null` | `null` | both | 0.1 | `null` → resolve `origin/HEAD`, fall back to `master`. |
| `appNames` | `string[]` | `[]` | both | 0.1 | PM2 apps to (re)start; the first is the health-gated web app. |
| `dbBoundApps` | `string[]` | `[]` | both | 0.1 | Apps stopped before migrate to release a SQLite lock; resumed on any failure. |
| `tunnelName` | `string \| null` | `null` | both | 0.1 | cloudflared PM2 process name — ops-verb display only (use `ensureApps` to keep it up). |
| `ensureApps` | `string[]` | `[]` | both | 0.4 | Auxiliary PM2 procs ensured up (tolerant) AFTER the app restart. A failure never fails the deploy. |
| `preDeployChecks` | `{name,command}[]` | `[]` | both | 0.4 | Gates run BEFORE anything is touched; non-zero aborts with nothing changed. |
| `postDeployChecks` | `{name,command}[]` | `[]` | both | 0.8 | Gates run after restart and every health probe succeeds; use public smoke journeys and asset checks. A failure reports the deploy as failed but does not silently roll back the live revision. |
| `preRestartChecks` | `{name,command}[]` | `[]` | both | 0.10 | Gates run IMMEDIATELY BEFORE the app restart (after build, with `dbBoundApps` still paused; after the release-layout flip). A failure resumes any paused apps (legacy) or runs phase recovery (release layout) before aborting. Also gates `rollback`'s restart. Use for a check against the freshly-built/flipped candidate right before it takes traffic — e.g. `port-guard` (see below). |
| `ecosystemFile` | `string \| null` | `null` | both | 0.3 | PM2 ecosystem file (rel. to `projectDir`). Enables first-deploy-safe `pm2 start … --only … --update-env \|\| pm2 restart … --update-env`; each deploy refreshes process env from the ecosystem file. |
| `port` | `number` | `3000` | both | 0.1 | Health-probe port (`http://localhost:<port>`). |
| `healthPath` | `string` | `'/api/health'` | both | 0.1 | Health-probe path. |
| `healthHeaders` | `Record<string,string>` | `{}` | both | 0.3.1 | Extra probe headers, e.g. `{"X-Forwarded-Proto":"https"}` behind a TLS proxy. |
| `healthChecks` | `{port?,path?,headers?}[]` | `[]` | both | 0.5 | Extra endpoints to gate (app+worker fleets). Omitted fields fall back to the scalars. |
| `health.attempts` | `number` | `30` | both | 0.1 | Health-poll attempts per endpoint. |
| `health.delaySeconds` | `number` | `2` | both | 0.1 | Delay between health polls. |
| `ssh.connectTimeout` | `number \| null` | `10` | ssh | 0.5 | `-o ConnectTimeout`; `null` omits. |
| `ssh.serverAliveInterval` | `number \| null` | `15` | ssh | 0.5 | `-o ServerAliveInterval`; `null` omits. |
| `ssh.serverAliveCountMax` | `number \| null` | `3` | ssh | 0.5 | `-o ServerAliveCountMax`; `null` omits. |
| `ssh.options` | `string[]` | `[]` | ssh | 0.5 | Extra raw `-o Key=Value` flags. |
| `stepTimeoutSeconds` | `number \| null` | `1800` | both | 0.5 | Per-command wall-clock timeout; explicit `null` = no limit. |
| `lock` | `boolean` | `true` | both | 0.5 | Take an atomic target lock so concurrent deploys can't interleave. |
| `buildBeforeMigrate` | `boolean` | `false` | both | 0.2 | Build while apps are UP (paused window = just migration). |
| `hooks.install` | `string` | `npm ci --prefer-offline \|\| npm ci \|\| npm install` | both | 0.1 | Dependency install; offline-first so a GitHub outage can't break a no-dep-change deploy. |
| `hooks.backup` | `string \| null` | `null` | both | 0.1 | Pre-migration backup **gate** — a failure aborts before any schema change. A safe final-line id/path or db-backup `--json` result is correlated to `deliveryEvent` as a leaf-only `backupReference`. |
| `hooks.migrate` | `string \| null` | `null` | both | 0.1 | Migration command; runs with `dbBoundApps` paused. |
| `hooks.build` | `string \| null` | `null` | both | 0.1 | Build command. |
| `hooks.restart` | `string \| null` | `null` | both | 0.3 | Override the app (re)start command. `null` → the `ecosystemFile`-aware start-or-restart idiom. |
| `hooks.restore` | `string \| null` | `null` | both | 0.7 | Restore the pre-migration DB backup during release-layout recovery (gets `DEPLOY_KIT_BACKUP_ID`). `null` = no auto-restore. |
| `layout` | `{type:'releases',…} \| null` | `null` | both | 0.7 | Opt-in artifact-first release layout (see below). `null` = legacy in-place deploy. |
| `layout.keepReleases` | `number` | `4` | both | 0.7 | Releases retained when pruning (≥1). |
| `layout.sharedPaths` | `string[]` | `[]` | both | 0.7 | Relative paths symlinked from `shared/` into every release (dirs, `.env`, uploads — never `node_modules` or a bare SQLite file). Validated relative + non-overlapping. |
| `layout.releaseChecks` | `{name,command}[]` | `[]` | both | 0.7 | Commands run INSIDE the candidate release before activation (prisma client loads, entrypoint present). Non-zero quarantines the candidate. |
| `layout.runningShaCommand` | `string \| null` | `null` | both | 0.7 | Returns the SHA the live app reports; asserted == deployed SHA post-flip. |
| `monitor` | `{…} \| null` | `null` | both | 0.8 | Opt-in fleet monitoring + alerting (see below). `null` = disabled. |
| `monitor.alert` | `{command, run?}` | — | both | 0.8 | Required. Policy-free sink; gets the batched alert JSON on stdin. `run`: `controller` (default) or `target`. |
| `monitor.publicProbes` | `{id,url,…}[]` | `[]` | both | 0.8 | External endpoint probes (unique `id`, https url). Proves DNS+ingress+TLS+routing. |
| `monitor.checks` | `{id,command,level?}[]` | `[]` | both | 0.8 | App-supplied checks; non-zero exit ⇒ alert at `level` (static severity). |
| `monitor.disk` / `.backup` / `.restartStorm` / `.tunnel` | see below | off | both | 0.8 | Built-in host checks (omit a key to skip it). |
| `monitor.failAfterRuns` / `.recoverAfterRuns` | `number` | `2` | both | 0.8 | Cross-run debounce before alert / recovery. |
| `monitor.reAlertAfterMinutes` | `number` | `0` | both | 0.8 | Re-fire a still-failing alert after N minutes (0 = quiet). |
| `monitor.stateFile` | `string` | `<dir>/.deploy-kit-monitor-state.json` | both | 0.8 | Abs path to monitor state — a STABLE dir, never under `releases/`. |
| `monitor.checkTimeoutSeconds` | `number` | `20` | both | 0.8 | Per-check wall-clock bound. |

### mode: local

Set `"mode": "local"` for a box that runs the deploy on itself (no SSH) — it runs
each step as `sh -c 'cd <projectDir> && …'` and skips the tracked-file stash. See
the local-mode example below.

### Release layout (artifact-first deploys)

The default (legacy) deploy runs `pull → npm ci → migrate → build → restart` **on
the live worktree** — `npm ci` and build mutate the very `node_modules`/generated
tree the running process is loading, which is how a mid-deploy restart hits
`@prisma/client did not initialize yet` and crash-loops. Adding a `layout` block
switches an app to an immutable-release layout where install and build never touch
the live tree:

```
/srv/<app>/
  repo.git/                 # bare repo (fetch target; never runnable)
  releases/<sha>-<ts>/      # one detached worktree per deploy, self-contained
  shared/                   # persistent state symlinked into each release
    .env  cache/npm  data/  ecosystem.config.cjs   # (literal cwd: …/current)
  current  -> releases/<active>     # atomic symlink; PM2 cwd points here
  previous -> releases/<known-good>
  .deploy-kit-layout        # versioned marker (host is migrated)
  .deploy-kit-state.json    # explicit release metadata
```

A `deploy` then: fetches into `repo.git`, resolves the exact SHA, `worktree add
--detach`es a new release, symlinks `sharedPaths` in, runs `hooks.install`
(`npm_config_cache` → `shared/cache/npm`) and `hooks.build` **inside the release**
while `current` still serves, validates it (`releaseChecks` + SHA match), and only
then opens the disruptive window — stop `dbBoundApps` → `hooks.backup` → `hooks.migrate`
→ atomic `mv -Tf` flip of `current` → `pm2 startOrRestart` from the stable
`ecosystemFile`. Activation is confirmed against `/proc/<pid>/cwd`, the app-reported
SHA (`layout.runningShaCommand`), PM2 online state, and a restart-count settling
window before the deploy is called healthy. `rollback` is an instant flip back to
`previous` (already built). A failed deploy recovers per phase and, if a migration
had already run, restores the backup (`hooks.restore`) or stops with `MANUAL
RECOVERY REQUIRED` — it never resumes stale code against a migrated schema.

Release deploy **requires a migrated host** (the `.deploy-kit-layout` marker) and a
stable `ecosystemFile` whose `cwd` is the literal `…/current`. deploy-kit never
performs the one-time host restructure — that is a separate, per-app, reversible
migration. A legacy deploy against a migrated host (or vice-versa) fails closed.

### `port-guard` (shared-host port-conflict guard)

On a multi-tenant host, a stale/unrelated process can end up squatting on the port
your app is about to (re)claim — the reload then either fails or, worse, silently
takes the WRONG process offline. `deploy-kit port-guard <port> <pm2-process-name>`
checks who currently holds `<port>`:

- nothing listening → exit 0 (free)
- every listener is `<pm2-process-name>`'s pm2 process or a descendant PID (BFS via
  `pgrep -P` / `ps --ppid`) → exit 0 (safe to reload)
- any listener is a foreign process → exit 1, naming the squatting PID(s)
- neither `lsof` nor `ss` is present on the host → exit 1 (**fails closed**; an
  unverifiable guard is not a passed guard)

It's a plain check command, so wire it into `preRestartChecks` (it then runs on the
target immediately before the restart, gating it):

```json
"preRestartChecks": [
  { "name": "port-safe", "command": "npx deploy-kit port-guard 3006 towerpower-app" }
]
```

### Monitoring (`deploy-kit monitor`)

Add a `monitor` block to turn on cron-driven ops monitoring + alerting. It runs the
generic checks every fleet host needs (so five apps don't each re-implement them) and
routes actionable alerts through a sink you supply:

```json
"monitor": {
  "disk": { "minFreeKiB": 524288, "minFreeInodes": 10000 },
  "backup": { "id": "db", "stampFile": "/var/lib/app/backups/.last-success", "maxAgeHours": 30 },
  "restartStorm": { "maxDelta": 3 },
  "tunnel": true,
  "publicProbes": [{ "id": "api", "url": "https://app.example.com/health", "expectStatus": 200 }],
  "checks": [{ "id": "ready", "command": "curl -fsS localhost:3002/ready", "level": "warn" }],
  "alert": { "command": "curl -fsS -X POST -d @- https://app.example.com/internal/alert", "run": "controller" },
  "failAfterRuns": 2, "recoverAfterRuns": 2, "reAlertAfterMinutes": 60,
  "stateFile": "/var/lib/app/deploy-kit-monitor-state.json"
}
```

Run it on a cron: `*/5 * * * * cd /path/to/app && npx deploy-kit monitor`. Each run
locks, reads state, runs every enabled check, and applies a per-check state machine:
a check must be non-`ok` for `failAfterRuns` consecutive runs before it alerts and `ok`
for `recoverAfterRuns` before it clears, so flapping is ridden out. A status of
`unknown` (ssh/command failure, unparseable output) never counts as ok or a recovery —
it holds. All transitions in a run are **batched into one alert event** (one incident
isn't four correlated pages), delivered to `alert.command` as JSON on **stdin**; the
event is persisted to `stateFile` *before* sending and retained for retry if delivery
fails (at-least-once; the `eventId` lets your sink dedupe). `alert.run: 'controller'`
runs the sink on the machine running deploy-kit (robust when the monitored app is what's
down); `'target'` runs it on the host. Exit codes: `0` ok/warn · `1` a critical
condition · `2` a monitor/config/delivery failure. Provider/scheduler-specific signals
belong in `checks[]` (statically-severitied) so they alert without flapping liveness —
keep the app's own `/live` vs `/ready` split app-side.

#### `alert-discord` — bundled Discord sink (opt-in convenience, not a policy change)

`monitor.alert` is deliberately **policy-free**: `monitor.js`/`checks.js` only know
how to hand the batched alert JSON to whatever `command` you configure — they have
no idea what Discord, Slack, or PagerDuty are, and this stays true after adding
`alert-discord`. What ships is a *consumer* of that same stdin-JSON contract, exactly
like a hand-rolled `curl` one-liner would be, just bundled so a project doesn't have
to hand-roll it:

```json
"monitor": {
  "alert": { "command": "npx deploy-kit alert-discord" }
}
```

It reads the batched alert event on stdin, resolves the webhook URL from
`process.env.DISCORD_ALERT_WEBHOOK` (override the env var name with
`--webhook-env NAME`), and POSTs with a 10s timeout. Use `--service NAME` or
`DISCORD_ALERT_SERVICE` to brand the message. Input is bounded to 256 KiB and
output to Discord's 2,000-character limit. Invalid or empty input is
non-retryable and exits `0`, preventing a poison batch from remaining in the
monitor outbox forever. An unset env var or a failed/timed-out POST remains a
genuine delivery failure and exits non-zero. The webhook URL is never logged.

#### `announce-discord` — bundled release sink (opt-in convenience, not a policy change)

The RELEASE counterpart to `alert-discord`, modeled 1:1 on it. `deliveryEvent`
is likewise deliberately **policy-free**: `deploy.js`/`release.js` only know how
to pipe the post-deploy event JSON to whatever `command` you configure, run
`tolerate: true` so a broken sink never fails the deploy. `announce-discord` is
just a bundled *consumer* of that stdin-JSON contract:

```json
"deliveryEvent": { "command": "npx deploy-kit announce-discord" }
```

It reads the delivery event on stdin (`{event:'deployment', status:'succeeded',
branch, revision, deployedAt, backupReference?}` — see `deploy.js`/`release.js`).
When either deploy layout captured a safe backup id, `backupReference` contains
only its opaque leaf label; host paths and unsafe/noisy output are omitted. It
resolves the webhook URL from `process.env.DISCORD_RELEASE_WEBHOOK` (override with
`--webhook-env NAME`), picks a service name from `--service NAME` /
`DISCORD_RELEASE_SERVICE` / `DISCORD_ALERT_SERVICE` (default `app`), formats
`🚀 \`<service>\` deployed \`<branch>@<shortsha>\` at <time>`, and POSTs it with
a 10s timeout — zero runtime deps, using Node's built-in `fetch`. The webhook
URL is never logged.

**Asymmetric vs `alert-discord` on purpose**: a release announcement is opt-in
decoration on top of an *already-tolerated* `deliveryEvent` step, not the
incident route itself. So an unset `DISCORD_RELEASE_WEBHOOK` prints
`announce-discord: DISCORD_RELEASE_WEBHOOK not set — skipping release
announcement` and **exits 0** — a missing release channel is a skip, never a
reason to turn a healthy deploy red. Malformed stdin and a failed/timed-out
POST are likewise a clear stderr warning and exit `0`. `alert-discord` also
drops malformed input because it cannot become valid on retry, but a missing
webhook or failed POST is retryable and exits non-zero because a broken
incident route is itself a problem.

## Use

```
npx deploy-kit init              # scaffold config + print scripts block
npx deploy-kit port-guard 3006 towerpower-app   # fail if 3006 is held by a foreign process
npx deploy-kit alert-discord [--webhook-env NAME] [--service NAME]  # convenience alert.command: post to Discord
npx deploy-kit announce-discord [--webhook-env NAME] [--service NAME]  # convenience deliveryEvent.command: post a release announcement
npx deploy-kit deploy            # full pipeline
npx deploy-kit deploy --dry-run  # print the command stream, execute nothing
npx deploy-kit rollback          # git reset to the pre-last-deploy SHA + rebuild + restart
npx deploy-kit dashboard         # status + health + git
npx deploy-kit status|health|resources|git
npx deploy-kit start|stop|restart
npx deploy-kit logs [--lines N] [--follow] [--errors]
```

### CLI reference

| Command | Flags | Does |
| --- | --- | --- |
| `init` | — | Write a `.deploy-kit.config.json` skeleton (never overwrites) + print the scripts block. |
| `port-guard <port> <pm2-process-name>` | — | Exit 0 if `<port>` is free or held only by `<pm2-process-name>`'s pm2 process tree; exit 1 (naming the PID) if a foreign process holds it, or if neither `lsof` nor `ss` is available (fails closed). Meant to run ON the target as a `preRestartChecks` command — see below. |
| `alert-discord` | `--webhook-env NAME` `--service NAME` | Convenience `alert.command`: read bounded monitor alert JSON on stdin and POST a length-safe message to Discord (env var `NAME`, default `DISCORD_ALERT_WEBHOOK`). Invalid/empty input exits 0 so a poison batch cannot retry forever; an unset webhook or failed POST remains non-zero. Opt-in — the monitor stays policy-free. |
| `announce-discord` | `--webhook-env NAME` `--service NAME` | Convenience `deliveryEvent.command`: read the post-deploy delivery event on stdin, POST a release announcement to a Discord webhook (env var `NAME`, default `DISCORD_RELEASE_WEBHOOK`). Always exits 0 — an unset env var, malformed stdin, or a failed/timed-out POST is a clear stderr warning, never a failure, since a broken announcement must never fail an already-succeeded deploy. Opt-in — deploy/release stay policy-free. |
| `deploy` | `--skip-build` `--skip-deps` `--skip-migrate` `--no-stash` `--dry-run` `--steal-lock` `--no-lock` | Run the full pipeline. |
| `rollback` | `--skip-build` `--skip-deps` `--steal-lock` | Reset to the recorded pre-deploy SHA, rebuild, restart, health-gate. |
| `monitor` | `--steal-lock` | Run the `monitor` checks, alert on transitions, exit `0`/`1`/`2`. For a cron. |
| `status` / `health` / `resources` / `git` / `dashboard` | — | Read-only target inspection. |
| `start` / `stop` / `restart` | — | PM2 lifecycle over `appNames`. |
| `logs` | `--lines N` `--follow` `--errors` | Tail PM2 logs for `appNames`. |

Or programmatically:

```js
const { loadConfig, deploy } = require('@andrewpopov/deploy-kit');
deploy(loadConfig());
```

## Safety behavior

- **Backup before migrate** — a failed `hooks.backup` aborts before any schema change.
- **SQLite-lock release** — `dbBoundApps` are `pm2 stop`ped before migrate and
  restarted on any post-stop failure, so a crashed migration/build never leaves
  them down.
- **`--ff-only` pull** and **tracked-only stash** (never sweeps untracked
  `.ssh`/`.cloudflared` into a stash); the deploy-kit stash is dropped after a
  successful pull so stashes don't pile up.
- **Concurrent-deploy lock** — an atomic `mkdir` lock stops two deploys of the
  same target from interleaving pm2 stop/start + git pulls.
- **ssh timeouts** — `ConnectTimeout`/`ServerAlive*` so a wedged route fails fast
  instead of hanging the pipeline with apps paused.
- **Health-gate** — polls `http://localhost:<port><healthPath>` (plus any
  `healthChecks`) and fails the deploy if it never returns 200.

Pair with [`@andrewpopov/db-backup`](https://github.com/andrewpopov/db-backup)
for the backup hook.

## Troubleshooting

- **Health probe returns 301, deploy fails as unhealthy.** The app force-redirects
  plain http to https behind a TLS-terminating proxy. Set
  `"healthHeaders": {"X-Forwarded-Proto": "https"}` so the localhost curl gets the
  real 200. (Since 0.3.1.)
- **First deploy of a brand-new PM2 process fails at restart.** `pm2 restart`
  requires the process to already exist. Set `ecosystemFile` so the deploy uses
  `pm2 start <file> --only <name> --update-env || pm2 restart <name> --update-env`.
  The environment refresh is required when the ecosystem file derives a release
  ID or other deploy-time configuration. (Since 0.3.0.)
- **"Another deploy holds the lock".** A previous deploy is still running, or one
  died without releasing. Wait, or pass `--steal-lock` to force past a stale lock.
- **Deploy hangs.** A wedged Tailscale/ssh route. The ssh `ConnectTimeout` bounds
  the connect; set `stepTimeoutSeconds` to bound a long-running remote command.
- **"Invalid deploy-kit config: unknown key …".** A typo or a removed key. The
  error lists valid keys / the migration. `ensureTunnelOnDeploy` → `ensureApps`.
- **A migration ran but you rolled the code back.** `deploy-kit rollback` reverts
  code only. Restore data with your db-backup restore command (the rollback prints
  a reminder when a `backup` hook is configured).

## Examples

**ssh mode — app + worker, both db-bound:**

```json
{
  "host": "shop@pi",
  "projectDir": "/srv/shop",
  "appNames": ["shop-app", "shop-worker"],
  "dbBoundApps": ["shop-app", "shop-worker"],
  "tunnelName": "shop-tunnel",
  "ensureApps": ["shop-tunnel"],
  "healthChecks": [{ "port": 3001, "path": "/worker/health" }],
  "hooks": {
    "backup": "npx db-backup backup --prod --allow-missing",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

**build before migrate, proxy health headers:**

```json
{
  "host": "blog@pi",
  "projectDir": "/srv/blog",
  "appNames": ["blog-app"],
  "dbBoundApps": ["blog-app"],
  "buildBeforeMigrate": true,
  "healthHeaders": { "X-Forwarded-Proto": "https" },
  "hooks": {
    "backup": "npx db-backup backup --prod",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

**local mode — ecosystem file, pre-deploy disk check:**

```json
{
  "mode": "local",
  "projectDir": "/srv/kiosk",
  "branch": "main",
  "appNames": ["kiosk-app"],
  "dbBoundApps": ["kiosk-app"],
  "tunnelName": "kiosk-tunnel",
  "ensureApps": ["kiosk-tunnel"],
  "ecosystemFile": "ecosystem.config.cjs",
  "preDeployChecks": [
    { "name": "disk", "command": "test \"$(df -Pk /srv/kiosk | awk 'NR==2{print $4}')\" -ge 512000" }
  ],
  "port": 3003,
  "hooks": {
    "install": "pnpm install --frozen-lockfile",
    "backup": "bash scripts/backup-db.sh",
    "migrate": "pnpm --filter @kiosk/api db:migrate",
    "build": "pnpm build"
  }
}
```

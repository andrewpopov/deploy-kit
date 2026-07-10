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
npm install github:andrewpopov/deploy-kit#v0.7.1
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
| `ecosystemFile` | `string \| null` | `null` | both | 0.3 | PM2 ecosystem file (rel. to `projectDir`). Enables first-deploy-safe `pm2 start … --only … \|\| pm2 restart …`. |
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
| `stepTimeoutSeconds` | `number \| null` | `null` | both | 0.5 | Per-command wall-clock timeout; `null` = no limit. |
| `lock` | `boolean` | `true` | both | 0.5 | Take an atomic target lock so concurrent deploys can't interleave. |
| `buildBeforeMigrate` | `boolean` | `false` | both | 0.2 | Build while apps are UP (paused window = just migration). |
| `hooks.install` | `string` | `npm ci --prefer-offline \|\| npm ci \|\| npm install` | both | 0.1 | Dependency install; offline-first so a GitHub outage can't break a no-dep-change deploy. |
| `hooks.backup` | `string \| null` | `null` | both | 0.1 | Pre-migration backup **gate** — a failure aborts before any schema change. |
| `hooks.migrate` | `string \| null` | `null` | both | 0.1 | Migration command; runs with `dbBoundApps` paused. |
| `hooks.build` | `string \| null` | `null` | both | 0.1 | Build command. |
| `hooks.restart` | `string \| null` | `null` | both | 0.3 | Override the app (re)start command. `null` → the `ecosystemFile`-aware start-or-restart idiom. |
| `hooks.restore` | `string \| null` | `null` | both | 0.7 | Restore the pre-migration DB backup during release-layout recovery (gets `DEPLOY_KIT_BACKUP_ID`). `null` = no auto-restore. |
| `layout` | `{type:'releases',…} \| null` | `null` | both | 0.7 | Opt-in artifact-first release layout (see below). `null` = legacy in-place deploy. |
| `layout.keepReleases` | `number` | `4` | both | 0.7 | Releases retained when pruning (≥1). |
| `layout.sharedPaths` | `string[]` | `[]` | both | 0.7 | Relative paths symlinked from `shared/` into every release (dirs, `.env`, uploads — never `node_modules` or a bare SQLite file). Validated relative + non-overlapping. |
| `layout.releaseChecks` | `{name,command}[]` | `[]` | both | 0.7 | Commands run INSIDE the candidate release before activation (prisma client loads, entrypoint present). Non-zero quarantines the candidate. |
| `layout.runningShaCommand` | `string \| null` | `null` | both | 0.7 | Returns the SHA the live app reports; asserted == deployed SHA post-flip. |

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

## Use

```
npx deploy-kit init              # scaffold config + print scripts block
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
| `deploy` | `--skip-build` `--skip-deps` `--skip-migrate` `--no-stash` `--dry-run` `--steal-lock` `--no-lock` | Run the full pipeline. |
| `rollback` | `--skip-build` `--skip-deps` `--steal-lock` | Reset to the recorded pre-deploy SHA, rebuild, restart, health-gate. |
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
  `pm2 start <file> --only <name> || pm2 restart <name>`. (Since 0.3.0.)
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

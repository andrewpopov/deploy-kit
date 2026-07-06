# @andrewpopov/deploy-kit

Hook-driven deploy pipeline + remote PM2 ops CLI + Cloudflare tunnel launcher for
the Raspberry-Pi service fleet (bewks, kira, smarthome, stoki, sano). Extracts the
`deploy.sh` / `remote-agent.js` tooling that was copy-pasted across those repos
(BWK-86).

## Install

```
npm install github:andrewpopov/deploy-kit#v0.1.0
```

## Configure

Drop a `.deploy-kit.config.json` in the repo root:

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
    "install": "npm ci || npm install",
    "backup": "npx db-backup backup --prod --allow-missing",
    "migrate": "npm run db:migrate:prod",
    "build": "npm run build"
  }
}
```

The `.deploy-kit.config.json` holding your real host/paths lives in each
**consumer** repo, never in this package.

The 4 hooks are the only framework-specific seams — everything else (git pull,
PM2 lifecycle, tunnel, health-gate) is shared.

### mode: local + ecosystem/aux processes (sano)

Set `"mode": "local"` for a box that runs the deploy on itself (no SSH) — it runs
each step as `sh -c 'cd <projectDir> && …'` and skips the tracked-file stash. These
generic (not tunnel-specific) fields fold in the rest of the hand-rolled `deploy.sh`:

- **`ecosystemFile`** — path to the PM2 ecosystem file (relative to `projectDir`).
  When set, `appNames` and `ensureApps` (re)start via
  `pm2 start <file> --only <name> 2>/dev/null || pm2 restart <name>`, so a
  not-yet-registered process starts on the first deploy and a running one restarts.
- **`ensureApps`** — auxiliary PM2 processes ensured up (tolerant) AFTER the main
  `appNames` restart: a cloudflared tunnel, a sidecar worker, anything that isn't
  the health-gated app. A failure here never fails the deploy. (`tunnelName` stays
  for ops-verb display only.)
- **`preDeployChecks`** — `[{ name, command }]` gates run BEFORE anything is touched.
  A non-zero exit aborts with nothing changed. For preconditions: free disk, DB
  reachable, required secret present.

```json
{
  "mode": "local",
  "projectDir": "/srv/sano-os",
  "branch": "main",
  "appNames": ["sano-app"],
  "dbBoundApps": ["sano-app"],
  "tunnelName": "sano-tunnel",
  "ensureApps": ["sano-tunnel"],
  "ecosystemFile": "ecosystem.config.cjs",
  "preDeployChecks": [
    { "name": "disk", "command": "test \"$(df -Pk /srv/sano-os | awk 'NR==2{print $4}')\" -ge 512000" }
  ],
  "port": 3003,
  "hooks": {
    "install": "pnpm install --frozen-lockfile",
    "backup": "bash scripts/backup-db.sh",
    "migrate": "pnpm --filter @sano/api db:migrate",
    "build": "pnpm build"
  }
}
```

## Use

```
npx deploy-kit deploy            # full pipeline (add --skip-build/-deps/-migrate)
npx deploy-kit dashboard         # status + health + git
npx deploy-kit restart|logs|health
```

Or programmatically:

```js
const { loadConfig, deploy } = require('@andrewpopov/deploy-kit');
deploy(loadConfig());
```

## Safety behavior (preserved from the originals)

- **Backup before migrate** — a failed `hooks.backup` aborts before any schema change.
- **SQLite-lock release** — `dbBoundApps` are `pm2 stop`ped before migrate and
  restarted on failure, so a crashed migration never leaves them down.
- **`--ff-only` pull** and **tracked-only stash** (never sweeps untracked
  `.ssh`/`.cloudflared` into a stash).
- **Health-gate** — polls `http://localhost:<port><healthPath>` and fails the
  deploy if it never returns 200.

Pair with [`@andrewpopov/db-backup`](https://github.com/andrewpopov/db-backup)
for the backup hook.

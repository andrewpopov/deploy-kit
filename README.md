# @andrewvpopov/deploy-kit

Hook-driven deploy pipeline + remote PM2 ops CLI + Cloudflare tunnel launcher for
the Raspberry-Pi service fleet (bewks, kira, smarthome, stoki, sano). Extracts the
`deploy.sh` / `remote-agent.js` tooling that was copy-pasted across those repos
(BWK-86).

## Install

```
npm install github:andrewvpopov/deploy-kit#v0.1.0
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
PM2 lifecycle, tunnel, health-gate) is shared. Set `"mode": "local"` for a box
that runs the deploy on itself (no SSH), like sano.

## Use

```
npx deploy-kit deploy            # full pipeline (add --skip-build/-deps/-migrate)
npx deploy-kit dashboard         # status + health + git
npx deploy-kit restart|logs|health
```

Or programmatically:

```js
const { loadConfig, deploy } = require('@andrewvpopov/deploy-kit');
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

Pair with [`@andrewvpopov/db-backup`](https://github.com/andrewvpopov/db-backup)
for the backup hook.

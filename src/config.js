'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = '.deploy-kit.config.json';

// Policy-free defaults. Every app supplies its own host/dir/app-names/hooks;
// only the shape and the safety-relevant defaults live here.
const DEFAULT_CONFIG = {
  host: null, // 'user@host' — required for mode:'ssh'
  projectDir: null, // absolute path on the target — required for mode:'ssh'
  mode: 'ssh', // 'ssh' (deploy from laptop) | 'local' (script runs on the box, e.g. sano)
  remote: 'origin',
  branch: null, // null → resolve origin/HEAD, fall back to 'master'
  appNames: [], // PM2 apps to (re)start
  dbBoundApps: [], // PM2 apps to stop before migrate to release a SQLite lock
  tunnelName: null, // PM2-managed cloudflared process name (for ops verbs)
  // Path (relative to projectDir) to the PM2 ecosystem file. When set, the deploy
  // (re)starts apps/tunnel via `pm2 start <file> --only <name> || pm2 restart <name>`
  // so a not-yet-registered process starts on first deploy and a running one
  // restarts. null → plain `pm2 restart <appNames>` (process must already exist).
  ecosystemFile: null,
  // When true and `tunnelName` is set, ensure the cloudflared tunnel is up at the
  // end of a deploy (tolerant — never fails the deploy). Off by default; ops verbs
  // still manage the tunnel regardless.
  ensureTunnelOnDeploy: false,
  port: 3000,
  healthPath: '/api/health',
  health: { attempts: 30, delaySeconds: 2 },
  // Build before the backup/stop/migrate block (apps stay up during build) so the
  // paused window is just migration. Default false = build after migrate (paused).
  buildBeforeMigrate: false,
  // The 4 framework-specific seams. Each is a shell command run on the target.
  hooks: {
    install: 'npm ci || npm install',
    backup: null, // pre-migration backup gate; abort deploy if it fails. null = skip.
    migrate: null, // e.g. 'npm run db:migrate:prod'. null = skip.
    build: null, // e.g. 'npm run build'. null = skip.
  },
};

function mergeConfig(base, override = {}) {
  const merged = { ...base, ...override };
  merged.health = { ...base.health, ...(override.health || {}) };
  merged.hooks = { ...base.hooks, ...(override.hooks || {}) };
  return merged;
}

// Load `.deploy-kit.config.json` from cwd (or a given dir) and merge over
// defaults, then over any inline override. Missing file is fine (defaults only).
function loadConfig({ cwd = process.cwd(), override = {}, fsImpl = fs } = {}) {
  let fileConfig = {};
  const configPath = path.join(cwd, CONFIG_FILENAME);
  if (fsImpl.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to parse ${CONFIG_FILENAME}: ${error.message}`);
    }
  }
  return mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), override);
}

module.exports = { CONFIG_FILENAME, DEFAULT_CONFIG, mergeConfig, loadConfig };

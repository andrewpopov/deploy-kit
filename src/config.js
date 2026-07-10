'use strict';

const fs = require('fs');
const path = require('path');
const { log: defaultLog } = require('./log');

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
  tunnelName: null, // PM2-managed cloudflared process name (for ops verbs / display)
  // Auxiliary PM2 processes to ensure are up (tolerant, start-or-restart) AFTER the
  // main appNames restart — a cloudflared tunnel, a sidecar worker, etc. Generic:
  // the tunnel is just one entry. A failure here never fails the deploy.
  ensureApps: [],
  // Pre-deploy check gates run BEFORE anything is touched. Each { name, command };
  // a non-zero exit aborts the deploy with nothing changed (free disk, DB reachable,
  // required secret present, …). The kit runs them; the consumer supplies them.
  preDeployChecks: [],
  // Path (relative to projectDir) to the PM2 ecosystem file. When set, the deploy
  // (re)starts apps/ensureApps via `pm2 start <file> --only <name> || pm2 restart <name>`
  // so a not-yet-registered process starts on first deploy and a running one
  // restarts. null → plain `pm2 restart <appNames>` (process must already exist).
  ecosystemFile: null,
  port: 3000,
  healthPath: '/api/health',
  // Extra headers for the health probe, e.g. { "X-Forwarded-Proto": "https" } for
  // an app that force-redirects plain http to https behind a TLS-terminating proxy.
  healthHeaders: {},
  // Additional health endpoints to gate the deploy on (app + worker fleets). Each
  // { port?, path?, headers? } — omitted fields fall back to the scalar
  // port/healthPath/healthHeaders. Empty → gate only the scalar endpoint.
  healthChecks: [],
  health: { attempts: 30, delaySeconds: 2 },
  // ssh hardening: a wedged Tailscale route must not hang a deploy forever with
  // db-bound apps paused. Applied to every `ssh` invocation (mode:'ssh' only).
  ssh: {
    connectTimeout: 10, // -o ConnectTimeout (seconds); null to omit
    serverAliveInterval: 15, // -o ServerAliveInterval (seconds); null to omit
    serverAliveCountMax: 3, // -o ServerAliveCountMax; null to omit
    options: [], // extra raw `-o Key=Value` strings appended verbatim
  },
  // Per-command wall-clock timeout in seconds. A hung step is killed and its step
  // fails, rather than holding the deploy lock forever and blocking every later
  // deploy. Generous by default: `npm ci` and `next build` on a Pi are slow, and a
  // bound nobody can hit is a bound nobody disables. Explicit `null` opts out.
  stepTimeoutSeconds: 1800,
  // Take an atomic lock on the target (mkdir) so two concurrent deploys can't
  // interleave pm2 stop/start + git pulls. false disables; --steal-lock overrides.
  lock: true,
  // Build before the backup/stop/migrate block (apps stay up during build) so the
  // paused window is just migration. Default false = build after migrate (paused).
  buildBeforeMigrate: false,
  // The framework-specific seams. Each is a shell command run on the target.
  hooks: {
    // Prefer the offline cache first so a GitHub outage can't break a deploy that
    // changes no dependencies (STANDARDS.md "The Pi deploy failure mode").
    install: 'npm ci --prefer-offline || npm ci || npm install',
    backup: null, // pre-migration backup gate; abort deploy if it fails. null = skip.
    migrate: null, // e.g. 'npm run db:migrate:prod'. null = skip.
    build: null, // e.g. 'npm run build'. null = skip.
    // Override the app (re)start command. null → the ecosystemFile-aware
    // start-or-restart idiom (see pm2StartOrRestart). Set this only when a repo
    // needs a bespoke restart (e.g. a wrapper script).
    restart: null,
  },
};

// Keys removed in past majors — a consumer still setting one gets a loud error
// with the migration, instead of the silent no-op that a plain spread produces.
const REMOVED_KEYS = {
  ensureTunnelOnDeploy:
    'removed in v0.4.0 — use "ensureApps": ["<your-tunnel-process>"] instead.',
};

// Expected type per top-level key, for the config validator. 'array'/'object'
// are checked specially; 'string?' etc. allow null.
const KEY_TYPES = {
  host: 'string?',
  projectDir: 'string?',
  mode: 'string',
  remote: 'string',
  branch: 'string?',
  appNames: 'array',
  dbBoundApps: 'array',
  tunnelName: 'string?',
  ensureApps: 'array',
  preDeployChecks: 'array',
  ecosystemFile: 'string?',
  port: 'number',
  healthPath: 'string',
  healthHeaders: 'object',
  healthChecks: 'array',
  health: 'object',
  ssh: 'object',
  stepTimeoutSeconds: 'number?',
  lock: 'boolean',
  buildBeforeMigrate: 'boolean',
  hooks: 'object',
};

function typeMatches(value, spec) {
  const nullable = spec.endsWith('?');
  const base = nullable ? spec.slice(0, -1) : spec;
  if (value == null) return nullable;
  if (base === 'array') return Array.isArray(value);
  if (base === 'object') return typeof value === 'object' && !Array.isArray(value);
  return typeof value === base; // 'string' | 'number' | 'boolean'
}

// Validate a raw config object (a parsed config file or an inline override).
// Returns an array of human-readable problem strings — empty means valid.
function validateConfig(raw, { source = 'config' } = {}) {
  const problems = [];
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [`${source} must be a JSON object`];
  }
  const validKeys = Object.keys(DEFAULT_CONFIG);
  for (const key of Object.keys(raw)) {
    if (key in REMOVED_KEYS) {
      problems.push(`${source}: "${key}" ${REMOVED_KEYS[key]}`);
      continue;
    }
    if (!validKeys.includes(key)) {
      problems.push(`${source}: unknown key "${key}" (valid keys: ${validKeys.join(', ')})`);
      continue;
    }
    if (!typeMatches(raw[key], KEY_TYPES[key])) {
      problems.push(`${source}: "${key}" must be ${KEY_TYPES[key].replace('?', ' or null')}`);
    }
  }
  if (raw.mode != null && raw.mode !== 'ssh' && raw.mode !== 'local') {
    problems.push(`${source}: "mode" must be "ssh" or "local"`);
  }
  // projectDir is interpolated raw into `cd <dir> && …` on the target, so it must
  // be an absolute path free of shell metacharacters/spaces — reject a typo here
  // rather than run the wrong command remotely.
  if (typeof raw.projectDir === 'string') {
    if (!raw.projectDir.startsWith('/')) {
      problems.push(`${source}: "projectDir" must be an absolute path (start with "/")`);
    } else if (/[^A-Za-z0-9_./-]/.test(raw.projectDir)) {
      problems.push(`${source}: "projectDir" must not contain spaces or shell metacharacters`);
    }
  }
  return problems;
}

function mergeConfig(base, override = {}) {
  const merged = { ...base, ...override };
  merged.health = { ...base.health, ...(override.health || {}) };
  merged.hooks = { ...base.hooks, ...(override.hooks || {}) };
  merged.ssh = { ...base.ssh, ...(override.ssh || {}) };
  return merged;
}

// Load `.deploy-kit.config.json` from cwd (or a given dir) and merge over
// defaults, then over any inline override. Missing file is fine (defaults only).
// Unknown/removed keys and wrong types are rejected by default (validate:true);
// pass `validate:false` to skip (or `strict:false` to warn instead of throw).
function loadConfig({
  cwd = process.cwd(),
  override = {},
  fsImpl = fs,
  validate = true,
  strict = true,
  log = defaultLog,
} = {}) {
  let fileConfig = {};
  const configPath = path.join(cwd, CONFIG_FILENAME);
  if (fsImpl.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fsImpl.readFileSync(configPath, 'utf8'));
    } catch (error) {
      throw new Error(`Failed to parse ${CONFIG_FILENAME}: ${error.message}`);
    }
  }

  if (validate) {
    const problems = [
      ...validateConfig(fileConfig, { source: CONFIG_FILENAME }),
      ...validateConfig(override, { source: 'override' }),
    ];
    if (problems.length) {
      const message = `Invalid deploy-kit config:\n  - ${problems.join('\n  - ')}`;
      if (strict) throw new Error(message);
      for (const p of problems) log.warning(p);
    }
  }

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, fileConfig), override);
}

module.exports = {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  REMOVED_KEYS,
  mergeConfig,
  validateConfig,
  loadConfig,
};

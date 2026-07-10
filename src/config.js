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
  // Deploy layout. null (default) = legacy in-place deploy on the live worktree —
  // exactly the behavior every app has today. An opt-in typed block switches an app
  // to artifact-first release deploys (SMH-112): each deploy builds an immutable
  // release under releases/, then an atomic `current` symlink flip activates it, so
  // `npm ci`/build never mutate the tree the live process is running from. The host
  // must be migrated to the release layout first (a completed layout marker); the
  // kit refuses release-mode deploy otherwise and never restructures a live root.
  //   layout: {
  //     type: 'releases',
  //     keepReleases: 4,                 // releases to retain when pruning (>=1)
  //     sharedPaths: ['.env', 'packages/api/prisma/data'],  // relative; symlinked
  //                                       // from shared/ into every release (dirs,
  //                                       // .env, uploads — NEVER node_modules or a
  //                                       // bare SQLite file with WAL/SHM sidecars)
  //     releaseChecks: [{ name, command }],  // run INSIDE the candidate release
  //                                       // before activation (prisma client loads,
  //                                       // entrypoint present) — a non-zero exit
  //                                       // quarantines the candidate, current stays.
  //     runningShaCommand: 'curl -s localhost:PORT/health | jq -r .buildSha',
  //                                       // returns the SHA the live app reports;
  //                                       // asserted == the deployed SHA post-flip.
  //   }
  layout: null,
  // Fleet monitoring + alerting (SMH-116). null (default) = disabled (no-op), so
  // apps are unaffected until they opt in (like `layout`). An opt-in block runs
  // generic ops checks on a cron and routes ACTIONABLE alerts through a policy-free
  // sink with cross-run debounce and batched delivery. See MONITOR.md / index.d.ts.
  //   monitor: {
  //     disk: { minFreeKiB: 524288, minFreeInodes: 10000 },   // omit to skip
  //     backup: { id: 'db', stampFile: '/var/lib/app/backups/.last-success', maxAgeHours: 30 },
  //     restartStorm: { maxDelta: 3 },                          // alert if restarts jump > maxDelta/run
  //     tunnel: true,                                           // assert tunnelName pm2 proc online
  //     publicProbes: [ { id: 'api', url: 'https://app/health', expectStatus: 200 } ],
  //     checks: [ { id: 'providers', command: 'curl -sf localhost:PORT/ready', level: 'warn' } ],
  //     alert: { command: 'curl -sf -d @- https://app/notify', run: 'controller' }, // gets JSON on stdin
  //     failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 0,
  //     stateFile: '/var/lib/app/deploy-kit-monitor-state.json',   // stable dir, NOT under releases
  //     checkTimeoutSeconds: 20,
  //   }
  monitor: null,
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
    // Restore the pre-migration DB backup during release-layout recovery (SMH-112).
    // Receives the captured backup id as DEPLOY_KIT_BACKUP_ID. null = no auto-restore;
    // recovery after a failed migration then aborts loudly with MANUAL RECOVERY
    // REQUIRED and the backup id, rather than resuming stale code on a new schema.
    restore: null,
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
  layout: 'object?',
  monitor: 'object?',
  hooks: 'object',
};

// A safe identifier for a state key / display: alnum, dot, dash, underscore. Used
// for probe/check/backup ids so they can't collide, escape, or be shell-injected.
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
const MONITOR_KEYS = ['disk', 'backup', 'restartStorm', 'tunnel', 'publicProbes', 'checks', 'alert', 'failAfterRuns', 'recoverAfterRuns', 'reAlertAfterMinutes', 'stateFile', 'checkTimeoutSeconds'];

function isPosInt(v) { return typeof v === 'number' && Number.isInteger(v) && v > 0; }

// Validate the opt-in `monitor` block. Enforces the invariants the state machine and
// alert delivery depend on: an alert sink with a valid run-location, unique safe ids
// for every probe/check (so per-check state can't collide), https-only probe urls
// free of shell metacharacters, and sane thresholds.
function validateMonitor(m, source) {
  const p = [];
  for (const k of Object.keys(m)) {
    if (!MONITOR_KEYS.includes(k)) p.push(`${source}: unknown monitor key "${k}" (valid: ${MONITOR_KEYS.join(', ')})`);
  }
  // alert sink is required — a monitor with no way to alert is pointless.
  if (m.alert == null || typeof m.alert !== 'object' || typeof m.alert.command !== 'string' || !m.alert.command) {
    p.push(`${source}: "monitor.alert.command" (a shell command; gets the alert JSON on stdin) is required`);
  } else if (m.alert.run != null && m.alert.run !== 'controller' && m.alert.run !== 'target') {
    p.push(`${source}: "monitor.alert.run" must be "controller" or "target"`);
  }
  const seen = new Set();
  const uniqueId = (id, where) => {
    if (typeof id !== 'string' || !SAFE_ID_RE.test(id)) { p.push(`${source}: ${where} needs a safe "id" (alnum . _ -)`); return; }
    if (seen.has(id)) p.push(`${source}: duplicate monitor id "${id}" (${where})`);
    seen.add(id);
  };
  if (m.publicProbes != null) {
    if (!Array.isArray(m.publicProbes)) p.push(`${source}: "monitor.publicProbes" must be an array`);
    else m.publicProbes.forEach((pr, i) => {
      const w = `publicProbes[${i}]`;
      if (pr == null || typeof pr !== 'object') { p.push(`${source}: ${w} must be an object`); return; }
      uniqueId(pr.id, w);
      // https-only (or explicit http), no shell metacharacters — the url is interpolated into curl.
      if (typeof pr.url !== 'string' || !/^https?:\/\/[^\s'"`$;&|<>()]+$/.test(pr.url)) {
        p.push(`${source}: ${w}.url must be an http(s) URL with no shell metacharacters`);
      } else if (!pr.url.startsWith('https://') && pr.url !== undefined) {
        // http allowed but flagged intentionally — most probes should be https.
      }
      if (pr.headers != null && (typeof pr.headers !== 'object' || Array.isArray(pr.headers))) p.push(`${source}: ${w}.headers must be an object`);
    });
  }
  if (m.checks != null) {
    if (!Array.isArray(m.checks)) p.push(`${source}: "monitor.checks" must be an array`);
    else m.checks.forEach((c, i) => {
      const w = `checks[${i}]`;
      if (c == null || typeof c !== 'object') { p.push(`${source}: ${w} must be an object`); return; }
      uniqueId(c.id, w);
      if (typeof c.command !== 'string' || !c.command) p.push(`${source}: ${w}.command must be a non-empty string`);
      if (c.level != null && c.level !== 'warn' && c.level !== 'crit') p.push(`${source}: ${w}.level must be "warn" or "crit"`);
    });
  }
  if (m.backup != null) {
    if (typeof m.backup !== 'object' || typeof m.backup.stampFile !== 'string' || !m.backup.stampFile.startsWith('/')) p.push(`${source}: "monitor.backup.stampFile" must be an absolute path`);
    if (m.backup && m.backup.maxAgeHours != null && !(typeof m.backup.maxAgeHours === 'number' && m.backup.maxAgeHours > 0)) p.push(`${source}: "monitor.backup.maxAgeHours" must be a positive number`);
  }
  if (m.disk != null) {
    if (m.disk.minFreeKiB != null && !isPosInt(m.disk.minFreeKiB)) p.push(`${source}: "monitor.disk.minFreeKiB" must be a positive integer`);
    if (m.disk.minFreeInodes != null && !isPosInt(m.disk.minFreeInodes)) p.push(`${source}: "monitor.disk.minFreeInodes" must be a positive integer`);
  }
  if (m.restartStorm != null && m.restartStorm.maxDelta != null && !(typeof m.restartStorm.maxDelta === 'number' && Number.isInteger(m.restartStorm.maxDelta) && m.restartStorm.maxDelta >= 0)) {
    p.push(`${source}: "monitor.restartStorm.maxDelta" must be a non-negative integer`);
  }
  for (const k of ['failAfterRuns', 'recoverAfterRuns', 'checkTimeoutSeconds']) {
    if (m[k] != null && !isPosInt(m[k])) p.push(`${source}: "monitor.${k}" must be a positive integer`);
  }
  if (m.reAlertAfterMinutes != null && !(typeof m.reAlertAfterMinutes === 'number' && m.reAlertAfterMinutes >= 0)) p.push(`${source}: "monitor.reAlertAfterMinutes" must be a non-negative number`);
  if (m.stateFile != null && (typeof m.stateFile !== 'string' || !m.stateFile.startsWith('/'))) p.push(`${source}: "monitor.stateFile" must be an absolute path`);
  if (m.tunnel != null && typeof m.tunnel !== 'boolean') p.push(`${source}: "monitor.tunnel" must be a boolean`);
  return p;
}

// Keys allowed inside a `layout` block, with their validators. Absence of most is
// fine (deploy normalizes defaults); `type` is the only required key.
const LAYOUT_KEYS = ['type', 'keepReleases', 'sharedPaths', 'releaseChecks', 'runningShaCommand'];

// Validate the opt-in `layout` block. Returns human-readable problem strings.
// Enforces Codex's shared-path safety rules at config time: relative, cannot
// escape the release, and no two paths overlap (one being a prefix of another
// would let one symlink hide the other).
function validateLayout(layout, source) {
  const problems = [];
  for (const key of Object.keys(layout)) {
    if (!LAYOUT_KEYS.includes(key)) {
      problems.push(`${source}: unknown layout key "${key}" (valid: ${LAYOUT_KEYS.join(', ')})`);
    }
  }
  if (layout.type !== 'releases') {
    problems.push(`${source}: "layout.type" must be "releases" (the only supported layout)`);
  }
  if (layout.keepReleases != null) {
    const n = layout.keepReleases;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
      problems.push(`${source}: "layout.keepReleases" must be an integer >= 1`);
    }
  }
  if (layout.runningShaCommand != null && typeof layout.runningShaCommand !== 'string') {
    problems.push(`${source}: "layout.runningShaCommand" must be a string`);
  }
  if (layout.releaseChecks != null) {
    if (!Array.isArray(layout.releaseChecks)) {
      problems.push(`${source}: "layout.releaseChecks" must be an array`);
    } else {
      layout.releaseChecks.forEach((c, i) => {
        if (c == null || typeof c !== 'object' || typeof c.name !== 'string' || typeof c.command !== 'string') {
          problems.push(`${source}: "layout.releaseChecks[${i}]" must be { name, command }`);
        }
      });
    }
  }
  if (layout.sharedPaths != null) {
    if (!Array.isArray(layout.sharedPaths)) {
      problems.push(`${source}: "layout.sharedPaths" must be an array`);
    } else {
      const seen = [];
      layout.sharedPaths.forEach((p, i) => {
        if (typeof p !== 'string' || p.length === 0) {
          problems.push(`${source}: "layout.sharedPaths[${i}]" must be a non-empty string`);
          return;
        }
        // Relative, no escape, no shell metacharacters — these are interpolated into
        // `ln`/`mkdir` on the target and must never point outside the release tree.
        if (p.startsWith('/')) {
          problems.push(`${source}: "layout.sharedPaths[${i}]" ("${p}") must be relative (no leading "/")`);
        }
        if (p.split('/').includes('..')) {
          problems.push(`${source}: "layout.sharedPaths[${i}]" ("${p}") must not contain ".." segments`);
        }
        if (/[^A-Za-z0-9_./-]/.test(p)) {
          problems.push(`${source}: "layout.sharedPaths[${i}]" ("${p}") must not contain spaces or shell metacharacters`);
        }
        // node_modules must NEVER be shared: a candidate `npm ci` would then mutate
        // the dependency tree the live process is loading — the exact hazard this
        // whole layout exists to remove. Reject it at any depth.
        if (p.split('/').includes('node_modules')) {
          problems.push(`${source}: "layout.sharedPaths[${i}]" ("${p}") must not share node_modules (it would be mutated by the candidate install)`);
        }
        const norm = p.replace(/\/+$/, '');
        for (const other of seen) {
          if (norm === other || norm.startsWith(`${other}/`) || other.startsWith(`${norm}/`)) {
            problems.push(`${source}: "layout.sharedPaths" entries "${other}" and "${p}" overlap`);
          }
        }
        seen.push(norm);
      });
    }
  }
  return problems;
}

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
  // `layout` type is checked above (object?); if present, validate its inner shape.
  if (raw.layout != null && typeof raw.layout === 'object' && !Array.isArray(raw.layout)) {
    problems.push(...validateLayout(raw.layout, source));
  }
  if (raw.monitor != null && typeof raw.monitor === 'object' && !Array.isArray(raw.monitor)) {
    problems.push(...validateMonitor(raw.monitor, source));
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

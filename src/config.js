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
  // Post-health gates run after the new app is healthy. Use them for public smoke
  // journeys and asset-contract checks that a localhost health probe cannot see.
  // Release-layout consumers must choose an explicit onFailure policy per check:
  // rollback, remain-active, or manual. Legacy consumers retain their historical
  // remain-active behavior until they move to the release layout.
  postDeployChecks: [],
  // Pre-restart check gates run IMMEDIATELY BEFORE the app (re)start step — after
  // build, with any dbBoundApps still paused. Each { name, command }; a non-zero
  // exit aborts the deploy (any paused db-bound apps are resumed first, same as
  // any other gate in that window). Use for a check that only makes sense against
  // the freshly-built candidate but must run before traffic-affecting restart
  // (e.g. a port-conflict guard). Generic: the kit runs them, the consumer supplies
  // them.
  preRestartChecks: [],
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
    // Host-key posture for unattended deploys: accept-new pins a first-seen key
    // (so later MITM is caught) without the interactive prompt that would hang a
    // cron/CI run, and BatchMode turns any remaining prompt into a fast failure.
    // Override either via `options` — see sshHardeningArgs for why that wins.
    strictHostKeyChecking: 'accept-new', // -o StrictHostKeyChecking; null to omit
    batchMode: 'yes', // -o BatchMode; null to omit
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
  // Abort the deploy when the target's installed packages disagree with what its
  // package.json pins. ON by default, because the failure it catches is silent by
  // construction: neither `npm install` nor `npm ci` re-resolves a changed
  // `github:owner/repo#ref`, so without this gate a stale dependency ships under a
  // green deploy. Set false only for a target you accept cannot be verified.
  verifyPins: true,
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
  // sink with cross-run debounce and batched delivery. See docs/MONITOR-DESIGN-REVIEW.md / index.d.ts.
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
  // Optional post-health delivery event. The command runs on the target and
  // receives structured deployment JSON on stdin; failures are reported but do
  // not turn a healthy deployment into a rollback.
  deliveryEvent: null,
  // The framework-specific seams. Each is a shell command run on the target.
  hooks: {
    // Prefer the offline cache first so a GitHub outage can't break a deploy that
    // changes no dependencies (STANDARDS.md "The Pi deploy failure mode").
    install: 'npm ci --prefer-offline || npm ci || npm install',
    // Codegen that writes into node_modules (e.g. `prisma generate`), run
    // unconditionally right after install, before build. Deliberately a
    // SEPARATE hook from `build`: a build tool with its own cache (Nx, Turbo)
    // can replay a cache HIT for the build command and skip everything inside
    // it, including a generate step baked into that script — `dist/` comes
    // back from the cache but node_modules/.prisma (wiped by `npm ci` above)
    // never gets regenerated, so the tree install just produced looks fine
    // and is actually unrunnable (PKG-127: clipd's api build was `prisma
    // generate && tsc -b`; Nx replayed 4/4 tasks from cache, `prisma
    // generate` never ran, and the app crash-looped in prod with
    // `@prisma/client did not initialize yet`). deploy-kit invokes this hook
    // directly — no build tool sits between it and the command, so no cache
    // can intercept it. null = skip (most apps have no codegen step).
    generate: null, // e.g. 'npx prisma generate'. null = skip.
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
  postDeployChecks: 'array',
  preRestartChecks: 'array',
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
  verifyPins: 'boolean',
  layout: 'object?',
  monitor: 'object?',
  deliveryEvent: 'object?',
  hooks: 'object',
};

// A safe identifier for a state key / display: alnum, dot, dash, underscore. Used
// for probe/check/backup ids so they can't collide, escape, or be shell-injected.
const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/;
// A git refname charset for `branch`/`remote`. Rather than blocklist shell
// metacharacters, allowlist the legal ones — git refnames never legally contain
// ";$|&`()<>" etc, so this is both a "well-formed ref" check AND the outer half
// of the injection defense. Call sites also shQuote these values (exec.js), so
// this is defense in depth rather than the only guard. Note the reverse case:
// with `branch: null` the branch is resolved at runtime from the target's own
// origin/HEAD and never passes through this validation at all — there, the
// call-site quoting is the only thing standing between a hostile refname and
// the target shell. Also blocks a leading "-" (would be read as a flag by git)
// and "..", "//", and a trailing "/", ".", or ".lock" (illegal per
// `git check-ref-format`).
const REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function isValidRefName(v) {
  if (typeof v !== 'string' || !REF_NAME_RE.test(v)) return false;
  if (v.includes('..') || v.includes('//')) return false;
  if (v.endsWith('/') || v.endsWith('.') || v.endsWith('.lock')) return false;
  return true;
}
const MONITOR_KEYS = ['disk', 'backup', 'restartStorm', 'tunnel', 'publicProbes', 'checks', 'alert', 'failAfterRuns', 'recoverAfterRuns', 'reAlertAfterMinutes', 'stateFile', 'checkTimeoutSeconds'];

function isPosInt(v) { return typeof v === 'number' && Number.isInteger(v) && v > 0; }

// ---- Nested-object validation (PKG-135 Finding 6) ------------------------
// `validateConfig` only ever allowlisted TOP-LEVEL keys (`Object.keys(DEFAULT_
// CONFIG)`) and type-checked each nested block as a whole ('object') -- never
// its CONTENTS. So "hooks.migarte" (a typo) validated fine, was never read,
// and silently left "hooks.migrate" disabled; the same gap applied to
// `health`, `ssh`, and monitor's own sub-blocks (disk/backup/restartStorm/
// alert never got an unknown-key check at all). `layout`/`monitor`/
// `deliveryEvent` HAD one each -- but as three separate hand-rolled copies of
// the same "for key of Object.keys(block) reject if not allowed" loop, added
// ad hoc whenever someone happened to be touching that one block. That's
// exactly how the gap happened: nobody added the same loop for `hooks`/
// `health`/`ssh` because no single mechanism made it obvious they needed one.
//
// `rejectUnknownKeys` is that one mechanism now -- every block-level key
// allowlist in this file (existing and new) calls it, so a block simply
// cannot end up unvalidated by omission again. `validateBlock` composes it
// with a lightweight per-key type check (reusing the same `typeMatches`/
// spec-string convention the top-level KEY_TYPES table already uses) for the
// blocks that only need "known key, right JS type" and nothing more elaborate
// -- `hooks`, `health`, `ssh`, and monitor's disk/backup/restartStorm/alert.
// Blocks with genuinely bespoke per-field rules (safe URL/path syntax,
// id uniqueness, positive-integer thresholds with a specific message, ...) —
// `layout`, `monitor` itself, `deliveryEvent`, and monitor's publicProbes/
// checks arrays — keep their existing hand-written value-level checks
// alongside this; only the "reject an unknown key" layer is now shared.
//
// A block whose keys are genuinely open (the KEY the caller supplies is user
// data, not a fixed config field an operator could typo) must NEVER be run
// through `rejectUnknownKeys`/`validateBlock` — checked for this codebase:
// `healthHeaders` and a `monitor.publicProbes[].headers` are raw HTTP-header
// maps keyed by whatever header name the operator wants to send, so neither
// is (or should be) validated this way; both are left exactly as before.
function rejectUnknownKeys(obj, allowed, source, label) {
  const problems = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      problems.push(`${source}: unknown ${label} key "${key}" (valid: ${allowed.join(', ')})`);
    }
  }
  return problems;
}

// `types` is a { key: spec } map using the same spec strings as KEY_TYPES
// ('string' | 'string?' | 'number' | 'number?' | 'boolean' | 'boolean?' |
// 'array' | 'array?'). Only keys ACTUALLY PRESENT on `obj` are type-checked —
// same lenient convention as the top-level check: a config may omit any key
// and get the default, so validation never demands a key be present, only
// that it be well-formed when it is. Caller must have already confirmed
// `obj` is a non-null, non-array object (every call site below does, via the
// same `!= null && typeof === 'object' && !Array.isArray` guard the existing
// `layout`/`monitor` calls use).
function validateBlock(obj, types, source, label) {
  const problems = rejectUnknownKeys(obj, Object.keys(types), source, label);
  for (const [key, spec] of Object.entries(types)) {
    if (key in obj && !typeMatches(obj[key], spec)) {
      problems.push(`${source}: "${label}.${key}" must be ${spec.replace('?', ' or null')}`);
    }
  }
  return problems;
}

// Documented shape of `hooks` (README's "Hooks" config-reference rows) — every
// hook the kit reads via `config.hooks.<name>`. `install` is the only
// non-nullable one: unlike the others (which mean "skip this step" when
// null), deploy.js always runs SOME install command.
const HOOKS_TYPES = {
  install: 'string',
  generate: 'string?',
  backup: 'string?',
  migrate: 'string?',
  build: 'string?',
  restart: 'string?',
  restore: 'string?',
};

// Documented shape of `health`.
const HEALTH_TYPES = { attempts: 'number', delaySeconds: 'number' };

// Documented shape of `ssh` (README's `ssh.*` rows).
const SSH_TYPES = {
  connectTimeout: 'number?',
  serverAliveInterval: 'number?',
  serverAliveCountMax: 'number?',
  options: 'array',
  strictHostKeyChecking: 'string?',
  batchMode: 'string?',
};

// Documented shape of monitor's own sub-blocks (used from validateMonitor
// below, alongside — not instead of — its existing bespoke value checks for
// these same blocks).
const MONITOR_DISK_TYPES = { minFreeKiB: 'number?', minFreeInodes: 'number?' };
const MONITOR_BACKUP_TYPES = { id: 'string?', stampFile: 'string', maxAgeHours: 'number?' };
const MONITOR_RESTART_STORM_TYPES = { maxDelta: 'number?' };
const MONITOR_ALERT_TYPES = { command: 'string', run: 'string?' };

function validateDeployChecks(checks, key, source) {
  const problems = [];
  if (checks == null) return problems;
  if (!Array.isArray(checks)) return [`${source}: "${key}" must be an array`];
  const names = new Set();
  checks.forEach((check, index) => {
    const where = `${key}[${index}]`;
    if (check == null || typeof check !== 'object' || Array.isArray(check)) {
      problems.push(`${source}: ${where} must be an object`);
      return;
    }
    if (typeof check.name !== 'string' || !check.name.trim()) problems.push(`${source}: ${where}.name must be a non-empty string`);
    else if (names.has(check.name)) problems.push(`${source}: duplicate ${key} name "${check.name}"`);
    else names.add(check.name);
    if (typeof check.command !== 'string' || !check.command.trim()) problems.push(`${source}: ${where}.command must be a non-empty string`);
    const allowedKeys = key === 'postDeployChecks' ? ['name', 'command', 'onFailure'] : ['name', 'command'];
    problems.push(...rejectUnknownKeys(check, allowedKeys, source, where));
    if (key === 'postDeployChecks' && check.onFailure != null
      && !['rollback', 'remain-active', 'manual'].includes(check.onFailure)) {
      problems.push(`${source}: ${where}.onFailure must be "rollback", "remain-active", or "manual"`);
    }
  });
  return problems;
}

const DELIVERY_EVENT_KEYS = ['command'];

// Validate the opt-in `deliveryEvent` block: `{ command }` only. deploy.js/
// release.js read `config.deliveryEvent?.command` — a typo'd key (e.g.
// "comand") would silently no-op the whole feature instead of erroring, so
// reject any key other than `command` and require `command` to actually be set.
function validateDeliveryEvent(de, source) {
  const problems = rejectUnknownKeys(de, DELIVERY_EVENT_KEYS, source, 'deliveryEvent');
  if (typeof de.command !== 'string' || !de.command.trim()) {
    problems.push(`${source}: "deliveryEvent.command" must be a non-empty string`);
  }
  return problems;
}

// Validate the opt-in `monitor` block. Enforces the invariants the state machine and
// alert delivery depend on: an alert sink with a valid run-location, unique safe ids
// for every probe/check (so per-check state can't collide), https-only probe urls
// free of shell metacharacters, and sane thresholds.
function validateMonitor(m, source) {
  const p = rejectUnknownKeys(m, MONITOR_KEYS, source, 'monitor');
  // alert sink is required — a monitor with no way to alert is pointless.
  if (m.alert == null || typeof m.alert !== 'object' || typeof m.alert.command !== 'string' || !m.alert.command) {
    p.push(`${source}: "monitor.alert.command" (a shell command; gets the alert JSON on stdin) is required`);
  } else if (m.alert.run != null && m.alert.run !== 'controller' && m.alert.run !== 'target') {
    p.push(`${source}: "monitor.alert.run" must be "controller" or "target"`);
  }
  // PKG-135 Finding 6: an unknown key inside alert/disk/backup/restartStorm
  // (e.g. "run" misspelled "ruun") used to validate fine and silently no-op —
  // these blocks never had an unknown-key check at all before this.
  if (m.alert != null && typeof m.alert === 'object' && !Array.isArray(m.alert)) {
    p.push(...validateBlock(m.alert, MONITOR_ALERT_TYPES, source, 'monitor.alert'));
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
      if (pr.headers != null) {
        if (typeof pr.headers !== 'object' || Array.isArray(pr.headers)) p.push(`${source}: ${w}.headers must be an object`);
        else for (const [hk, hv] of Object.entries(pr.headers)) {
          // Header key/value are single-quoted into the curl command; a single quote
          // would escape the quoting and inject. Reject it (matches buildHealthCommand).
          if (String(hk).includes("'") || String(hv).includes("'")) p.push(`${source}: ${w}.headers["${hk}"] must not contain a single quote`);
        }
      }
      // expectStatus is compared (as a string) against curl's %{http_code} —
      // must be a real HTTP status code, or an array of them (checks.js).
      if (pr.expectStatus != null) {
        const statuses = Array.isArray(pr.expectStatus) ? pr.expectStatus : [pr.expectStatus];
        if (statuses.length === 0 || statuses.some((s) => typeof s !== 'number' || !Number.isInteger(s) || s < 100 || s > 599)) {
          p.push(`${source}: ${w}.expectStatus must be an HTTP status code (100-599) or a non-empty array of them`);
        }
      }
      // expectBodyIncludes is only ever compared with JS String#includes() against
      // the fetched body (checks.js) — never shell-interpolated — so just a
      // non-empty string, no metacharacter restriction needed.
      if (pr.expectBodyIncludes != null && (typeof pr.expectBodyIncludes !== 'string' || !pr.expectBodyIncludes)) {
        p.push(`${source}: ${w}.expectBodyIncludes must be a non-empty string`);
      }
      // maxTimeSeconds is interpolated into `curl --max-time ${maxTime}`; a
      // validated number can never carry a shell metacharacter when stringified.
      if (pr.maxTimeSeconds != null && !(typeof pr.maxTimeSeconds === 'number' && pr.maxTimeSeconds > 0)) {
        p.push(`${source}: ${w}.maxTimeSeconds must be a positive number`);
      }
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
  // Absolute path with NO shell metacharacters — it is interpolated into `stat`/`cat`
  // commands on the target (defense-in-depth alongside the single-quoting there).
  const safeAbsPath = (v) => typeof v === 'string' && v.startsWith('/') && !/[^A-Za-z0-9_./-]/.test(v);
  if (m.backup != null) {
    if (typeof m.backup !== 'object' || !safeAbsPath(m.backup.stampFile)) p.push(`${source}: "monitor.backup.stampFile" must be an absolute path free of shell metacharacters`);
    if (m.backup && m.backup.maxAgeHours != null && !(typeof m.backup.maxAgeHours === 'number' && m.backup.maxAgeHours > 0)) p.push(`${source}: "monitor.backup.maxAgeHours" must be a positive number`);
    if (typeof m.backup === 'object' && !Array.isArray(m.backup)) p.push(...validateBlock(m.backup, MONITOR_BACKUP_TYPES, source, 'monitor.backup'));
  }
  if (m.disk != null) {
    if (m.disk.minFreeKiB != null && !isPosInt(m.disk.minFreeKiB)) p.push(`${source}: "monitor.disk.minFreeKiB" must be a positive integer`);
    if (m.disk.minFreeInodes != null && !isPosInt(m.disk.minFreeInodes)) p.push(`${source}: "monitor.disk.minFreeInodes" must be a positive integer`);
    if (typeof m.disk === 'object' && !Array.isArray(m.disk)) p.push(...validateBlock(m.disk, MONITOR_DISK_TYPES, source, 'monitor.disk'));
  }
  if (m.restartStorm != null && m.restartStorm.maxDelta != null && !(typeof m.restartStorm.maxDelta === 'number' && Number.isInteger(m.restartStorm.maxDelta) && m.restartStorm.maxDelta >= 0)) {
    p.push(`${source}: "monitor.restartStorm.maxDelta" must be a non-negative integer`);
  }
  if (m.restartStorm != null && typeof m.restartStorm === 'object' && !Array.isArray(m.restartStorm)) {
    p.push(...validateBlock(m.restartStorm, MONITOR_RESTART_STORM_TYPES, source, 'monitor.restartStorm'));
  }
  for (const k of ['failAfterRuns', 'recoverAfterRuns', 'checkTimeoutSeconds']) {
    if (m[k] != null && !isPosInt(m[k])) p.push(`${source}: "monitor.${k}" must be a positive integer`);
  }
  if (m.reAlertAfterMinutes != null && !(typeof m.reAlertAfterMinutes === 'number' && m.reAlertAfterMinutes >= 0)) p.push(`${source}: "monitor.reAlertAfterMinutes" must be a non-negative number`);
  if (m.stateFile != null && !safeAbsPath(m.stateFile)) p.push(`${source}: "monitor.stateFile" must be an absolute path free of shell metacharacters`);
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
  const problems = rejectUnknownKeys(layout, LAYOUT_KEYS, source, 'layout');
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
  problems.push(...validateDeployChecks(raw.preDeployChecks, 'preDeployChecks', source));
  problems.push(...validateDeployChecks(raw.postDeployChecks, 'postDeployChecks', source));
  if (raw.layout?.type === 'releases' && Array.isArray(raw.postDeployChecks)) {
    raw.postDeployChecks.forEach((check, index) => {
      if (check && !['rollback', 'remain-active', 'manual'].includes(check.onFailure)) {
        problems.push(`${source}: postDeployChecks[${index}].onFailure is required for release layouts`);
      }
    });
  }
  problems.push(...validateDeployChecks(raw.preRestartChecks, 'preRestartChecks', source));
  // `layout` type is checked above (object?); if present, validate its inner shape.
  if (raw.layout != null && typeof raw.layout === 'object' && !Array.isArray(raw.layout)) {
    problems.push(...validateLayout(raw.layout, source));
  }
  if (raw.monitor != null && typeof raw.monitor === 'object' && !Array.isArray(raw.monitor)) {
    problems.push(...validateMonitor(raw.monitor, source));
  }
  // `hooks`/`health`/`ssh` type is checked above (object); validate their inner
  // shape too (PKG-135 Finding 6) — a typo like "hooks.migarte" used to validate
  // fine (only the top-level "hooks" key was ever allowlisted) and silently
  // leave "hooks.migrate" at its default (disabled).
  if (raw.hooks != null && typeof raw.hooks === 'object' && !Array.isArray(raw.hooks)) {
    problems.push(...validateBlock(raw.hooks, HOOKS_TYPES, source, 'hooks'));
  }
  if (raw.health != null && typeof raw.health === 'object' && !Array.isArray(raw.health)) {
    problems.push(...validateBlock(raw.health, HEALTH_TYPES, source, 'health'));
  }
  if (raw.ssh != null && typeof raw.ssh === 'object' && !Array.isArray(raw.ssh)) {
    problems.push(...validateBlock(raw.ssh, SSH_TYPES, source, 'ssh'));
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
  // branch/remote reach remote shell commands (`git pull --ff-only`, `git
  // rev-parse`). They are shQuoted at those call sites; rejecting anything
  // outside a legal git refname charset here fails fast at load instead of
  // relying on quoting alone. See REF_NAME_RE/isValidRefName above.
  if (typeof raw.branch === 'string' && !isValidRefName(raw.branch)) {
    problems.push(`${source}: "branch" ("${raw.branch}") must be a valid git ref name (letters, digits, ".", "_", "-", "/"; no "..", no leading "-", no shell metacharacters)`);
  }
  if (typeof raw.remote === 'string' && !isValidRefName(raw.remote)) {
    problems.push(`${source}: "remote" ("${raw.remote}") must be a valid git ref name (letters, digits, ".", "_", "-", "/"; no "..", no leading "-", no shell metacharacters)`);
  }
  if (raw.deliveryEvent != null && typeof raw.deliveryEvent === 'object' && !Array.isArray(raw.deliveryEvent)) {
    problems.push(...validateDeliveryEvent(raw.deliveryEvent, source));
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

'use strict';

const { runOnTarget, buildHealthCommand } = require('./exec');
const { acquireLock } = require('./lock');
const { log: defaultLog } = require('./log');

// Bump when the on-host layout changes shape. The host migration writes this
// version into .deploy-kit-layout; a release deploy refuses a host whose marker
// is absent or a different version, so an out-of-date host can't be deployed to.
const LAYOUT_VERSION = 1;

// Post-restart settling window: after the app is healthy, sample PM2 restart
// counts this many times, this many seconds apart, and require they never climb.
// Catches a crash-loop that answers one healthy probe between restarts.
const SETTLE_SAMPLES = 3;
const SETTLE_DELAY_SECONDS = 3;

// Minimum free space (KiB) required on the target FS before an install. Filling
// the disk during `npm ci` can corrupt the live SQLite app even though the build
// happens in another directory (Codex). ~500 MiB.
const MIN_FREE_KIB = 512 * 1024;

function defaultSleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

// All host paths derived from the app root (config.projectDir). Everything the
// release layout touches lives under here; nothing is inferred at runtime except
// current/previous, which are read from the symlinks themselves.
function releasePaths(config) {
  const root = config.projectDir;
  return {
    root,
    repoGit: `${root}/repo.git`,
    releasesDir: `${root}/releases`,
    sharedDir: `${root}/shared`,
    currentLink: `${root}/current`,
    previousLink: `${root}/previous`,
    markerFile: `${root}/.deploy-kit-layout`,
    stateFile: `${root}/.deploy-kit-state.json`,
    npmCache: `${root}/shared/cache/npm`,
  };
}

function isReleaseLayout(config) {
  return Boolean(config.layout && config.layout.type === 'releases');
}

// Run one command on the target in a chosen directory (buildTargetCommand prefixes
// `cd <projectDir> &&`, so we clone the config with projectDir swapped to `dir`).
function runInDir(dir, command, config, ctx, { capture = false, tolerate = false } = {}) {
  const res = runOnTarget(command, { ...config, projectDir: dir }, { capture, runtime: ctx.runtime });
  if (!res.ok && !tolerate && !capture) {
    throw new Error(`Deploy aborted: command failed in ${dir}: ${command}`);
  }
  return res;
}

// Capture trimmed stdout of a command on the target (returns '' on failure).
function capture(dir, command, config, ctx) {
  const res = runOnTarget(command, { ...config, projectDir: dir }, { capture: true, runtime: ctx.runtime });
  return (res.output || '').trim();
}

// PM2 restart command from the STABLE ecosystem file (literal cwd:current). Never
// bake a real release path into PM2 — startOrRestart re-resolves the symlink when
// it respawns each child (verified post-flip via /proc/<pid>/cwd). Not `reload`
// (graceful overlap is undesirable around a SQLite migration).
function pm2Activate(config, paths) {
  const eco = `${paths.root}/${config.ecosystemFile}`;
  return `pm2 startOrRestart ${eco} --update-env`;
}

// Parse `pm2 jlist` JSON into { name -> { pid, restarts, online } } for our apps.
function readPm2(config, paths, ctx) {
  const out = capture(paths.root, 'pm2 jlist', config, ctx);
  let list;
  try {
    list = JSON.parse(out || '[]');
  } catch {
    return null; // unparseable — caller treats as a failed check
  }
  const byName = {};
  for (const proc of list) {
    const env = proc.pm2_env || {};
    byName[proc.name] = {
      pid: proc.pid,
      restarts: env.restart_time != null ? env.restart_time : (proc.restart_time || 0),
      online: (env.status || proc.status) === 'online',
    };
  }
  return byName;
}

// Poll the health endpoint(s) until 200 or attempts exhausted (same probe the
// legacy path uses). Returns true/false; does not assert cwd/SHA (that is layered
// on top in verifyActivation).
function waitForHealth(config, ctx) {
  const { attempts, delaySeconds } = config.health;
  const checks = [{}, ...(config.healthChecks || [])];
  for (const check of checks) {
    const command = buildHealthCommand(config, check);
    let ok = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const res = runOnTarget(command, config, { capture: true, runtime: ctx.runtime });
      if ((res.output || '').trim() === '200') { ok = true; break; }
      if (attempt < attempts) ctx.sleep(delaySeconds);
    }
    if (!ok) return false;
  }
  return true;
}

// Full activation verification (Codex's five conditions). A deploy "succeeds" only
// when ALL hold, so an old process answering 200 can't mask a failed flip.
//   1. health endpoint(s) return 200
//   2. every managed PID's /proc/<pid>/cwd resolves to the new release
//   3. the running app reports the deployed SHA (if runningShaCommand is set)
//   4. PM2 reports every app online
//   5. restart counts stay flat across the settling window
// Returns { ok, reason }.
function verifyActivation(config, paths, sha, releaseDir, ctx) {
  const log = ctx.log;
  if (!waitForHealth(config, ctx)) return { ok: false, reason: 'health endpoint never returned 200' };

  const pm2 = readPm2(config, paths, ctx);
  if (!pm2) return { ok: false, reason: 'could not read `pm2 jlist`' };

  const canonicalRelease = capture(paths.root, `readlink -f ${releaseDir}`, config, ctx);
  for (const name of config.appNames) {
    const proc = pm2[name];
    if (!proc || !proc.online) return { ok: false, reason: `PM2 process ${name} is not online` };
    if (proc.pid == null) return { ok: false, reason: `PM2 process ${name} has no pid` };
    const cwd = capture(paths.root, `readlink -f /proc/${proc.pid}/cwd`, config, ctx);
    if (cwd !== canonicalRelease) {
      return { ok: false, reason: `${name} (pid ${proc.pid}) cwd is ${cwd || '<unknown>'}, expected ${canonicalRelease}` };
    }
  }

  // SHA assertion only applies to a forward deploy (a known target SHA). Recovery
  // and rollback verify the PREVIOUS release with sha=null and skip this check.
  if (config.layout.runningShaCommand && sha) {
    const running = capture(paths.root, config.layout.runningShaCommand, config, ctx);
    if (!running || sha.slice(0, 12) !== running.slice(0, 12)) {
      return { ok: false, reason: `running app reports SHA ${running || '<none>'}, expected ${sha.slice(0, 12)}` };
    }
  }

  // Settling window: restart counts must not climb (a crash-loop keeps restarting).
  let baseline = null;
  for (let i = 0; i < SETTLE_SAMPLES; i += 1) {
    const snap = readPm2(config, paths, ctx);
    if (!snap) return { ok: false, reason: 'could not read `pm2 jlist` during settle' };
    for (const name of config.appNames) {
      const r = snap[name] ? snap[name].restarts : null;
      if (r == null) return { ok: false, reason: `PM2 process ${name} vanished during settle` };
      if (baseline && r > baseline[name]) {
        return { ok: false, reason: `${name} restarted during the settling window (crash loop): ${baseline[name]} -> ${r}` };
      }
    }
    if (!baseline) baseline = Object.fromEntries(config.appNames.map((n) => [n, snap[n].restarts]));
    if (i < SETTLE_SAMPLES - 1) ctx.sleep(SETTLE_DELAY_SECONDS);
  }
  if (log) log.success('Activation verified (cwd + SHA + online + restart counts stable)');
  return { ok: true };
}

// Read the current/previous release targets (relative, e.g. "releases/<id>") from
// the symlinks — never inferred from directory listings.
function readPointers(config, paths, ctx) {
  const current = capture(paths.root, `readlink ${paths.currentLink} 2>/dev/null || true`, config, ctx);
  const previous = capture(paths.root, `readlink ${paths.previousLink} 2>/dev/null || true`, config, ctx);
  return { current: current || null, previous: previous || null };
}

// Preflight: host is migrated (marker present + version matches), GNU coreutils
// (mv -T is namespace-atomic), a stable ecosystem file is configured, and there is
// enough free disk. Any failure aborts before a single file is written.
function preflight(config, paths, ctx) {
  const marker = capture(paths.root, `cat ${paths.markerFile} 2>/dev/null || true`, config, ctx);
  if (!marker) {
    throw new Error(
      `Release deploy requires a migrated host: ${paths.markerFile} is missing. Run the one-time host `
      + `migration first (it writes the layout marker). deploy-kit never restructures a live root.`,
    );
  }
  let parsed;
  try { parsed = JSON.parse(marker); } catch { parsed = null; }
  if (!parsed || parsed.layout !== 'releases' || parsed.version !== LAYOUT_VERSION) {
    throw new Error(
      `Host layout marker mismatch (${paths.markerFile}): got ${marker}, expected `
      + `{"layout":"releases","version":${LAYOUT_VERSION}}. Re-run the host migration for this deploy-kit version.`,
    );
  }
  if (!config.ecosystemFile) {
    throw new Error('Release deploy requires `ecosystemFile` (the stable PM2 ecosystem with literal cwd:<root>/current).');
  }
  const mvGnu = capture(paths.root, 'mv --version 2>/dev/null | head -1', config, ctx);
  if (!/GNU|coreutils/i.test(mvGnu)) {
    throw new Error('Release deploy requires GNU coreutils `mv` (for the atomic `mv -T` symlink swap); not detected on target.');
  }
  const avail = parseInt(capture(paths.root, `df -kP ${paths.root} | awk 'NR==2{print $4}'`, config, ctx), 10);
  if (Number.isFinite(avail) && avail < MIN_FREE_KIB) {
    throw new Error(`Insufficient free disk on ${paths.root}: ${avail} KiB free, need >= ${MIN_FREE_KIB} KiB.`);
  }
}

// The full artifact-first release deploy. See the failure-phase table in the ticket:
// every phase records enough state that recover() can restore a known-good running
// release, and the ONLY disruptive window is stop → backup → migrate → flip.
function deployRelease(config, options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const c = { ...ctx, log, sleep, runtime: ctx.runtime };
  const paths = releasePaths(config);
  const { skipMigrate = false, stealLock = false } = options;

  log.header(`🚀 Deploying [release layout] (${config.mode}${config.host ? ` → ${config.host}` : ''})`);

  const steps = [];
  // Mutable state the recovery machine reads. phase names match the failure table.
  const st = { phase: 'preflight', dbAppsPaused: false, flipped: false, prevTarget: null, releaseDir: null, sha: null, backupId: null, migrated: false };

  const resumePrevious = () => {
    // Bring the previous release's apps back and verify it is actually healthy —
    // a zero-exit `pm2 start` is not proof (Codex).
    runInDir(paths.root, pm2Activate(config, paths), config, c, { tolerate: true });
    return verifyActivation(config, paths, null, `${paths.root}/${st.prevTarget}`, c);
  };

  const restoreDb = () => {
    if (!config.hooks.restore) return false;
    const env = st.backupId ? `DEPLOY_KIT_BACKUP_ID=${st.backupId} ` : '';
    const res = runInDir(paths.root, `${env}${config.hooks.restore}`, config, c, { tolerate: true });
    return res.ok;
  };

  // Phase-appropriate recovery. Returns nothing; throws a distinct MANUAL RECOVERY
  // error if it cannot restore a known-good running release (never a routine abort).
  const recover = (err) => {
    const fail = (msg) => { throw new Error(`MANUAL RECOVERY REQUIRED — ${msg}. Original: ${err && err.message}`); };
    log.error(`Deploy failed in phase "${st.phase}": ${err && err.message}`);
    switch (st.phase) {
      case 'preflight':
      case 'materialize':
      case 'install':
      case 'build':
      case 'validate':
        // current never touched, apps never stopped — just quarantine the candidate.
        if (st.releaseDir) {
          log.warning(`Quarantining candidate release ${st.releaseDir}`);
          runInDir(paths.root, `git --git-dir=${paths.repoGit} worktree remove --force ${st.releaseDir} 2>/dev/null || rm -rf ${st.releaseDir}`, config, c, { tolerate: true });
          runInDir(paths.root, `git --git-dir=${paths.repoGit} worktree prune 2>/dev/null || true`, config, c, { tolerate: true });
        }
        return;
      case 'stopped':
        // writers stopped, nothing migrated/flipped — resume previous, verify.
        if (!resumePrevious().ok) fail('failed to bring the previous release back online after aborting pre-migration');
        return;
      case 'migrated':
      case 'flipped':
      case 'verify': {
        // Schema changed and/or symlink flipped. Flip back first if needed, restore
        // the DB (old code may not run against the new schema), then resume previous.
        if (st.flipped && st.prevTarget) {
          log.warning(`Flipping current back to ${st.prevTarget}`);
          activateSymlink(config, paths, st.prevTarget, c, { tolerate: true });
        }
        if (st.migrated) {
          if (!restoreDb()) {
            fail(`a migration ran but the DB could not be auto-restored (backup ${st.backupId || 'unknown'}); restore it by hand before serving traffic`);
          }
          log.warning(`Restored pre-migration DB backup ${st.backupId || ''}`);
        }
        if (!resumePrevious().ok) fail('the previous release did not come back healthy after DB/symlink recovery');
        return;
      }
      default:
        fail(`unknown phase "${st.phase}"`);
    }
  };

  const onSignal = (sig) => {
    log.error(`Received ${sig} mid-deploy — running recovery for phase "${st.phase}"`);
    try { recover(new Error(`interrupted by ${sig}`)); } catch (e) { log.error(e.message); }
    process.exit(1);
  };
  const sigHandlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };

  const release = acquireLock(config, c, { steal: stealLock });
  process.on('SIGINT', sigHandlers.SIGINT);
  process.on('SIGTERM', sigHandlers.SIGTERM);
  try {
    preflight(config, paths, c);
    for (const check of config.preDeployChecks) {
      st.phase = 'preflight';
      const res = runInDir(paths.root, check.command, config, c, { tolerate: true });
      if (!res.ok) throw new Error(`Pre-deploy check failed: ${check.name}`);
    }

    const pointers = readPointers(config, paths, c);
    st.prevTarget = pointers.current; // the release we will fall back to

    // ---- Phase: materialize (current untouched) ----
    st.phase = 'materialize';
    log.step('Fetching into the bare repo');
    runInDir(paths.root, `git --git-dir=${paths.repoGit} fetch --prune ${config.remote}`, config, c);
    const branch = config.branch || 'master';
    st.sha = capture(paths.root, `git --git-dir=${paths.repoGit} rev-parse ${config.remote}/${branch}`, config, c);
    if (!/^[0-9a-f]{40}$/.test(st.sha)) throw new Error(`Could not resolve ${config.remote}/${branch} to a SHA (got "${st.sha}")`);
    const ts = capture(paths.root, 'date -u +%Y%m%dT%H%M%SZ', config, c);
    const releaseId = `${st.sha.slice(0, 12)}-${ts}`;
    st.releaseDir = `${paths.releasesDir}/${releaseId}`;
    log.step(`Materializing release ${releaseId} at ${st.sha.slice(0, 12)}`);
    runInDir(paths.root, `git --git-dir=${paths.repoGit} worktree add --detach ${st.releaseDir} ${st.sha}`, config, c);
    steps.push('materialize');

    // Symlink shared state in (verifying the release does not track the path).
    for (const rel of (config.layout.sharedPaths || [])) {
      const src = `${paths.sharedDir}/${rel}`;
      const dest = `${st.releaseDir}/${rel}`;
      const tracked = capture(st.releaseDir, `git ls-files --error-unmatch ${rel} 2>/dev/null && echo TRACKED || true`, config, c);
      if (tracked.includes('TRACKED')) {
        throw new Error(`sharedPath "${rel}" is tracked in the release — it would hide a committed file. Remove it from git or from sharedPaths.`);
      }
      // The shared source must already exist (the host migration creates it); fail
      // closed rather than symlink to a missing target.
      runInDir(paths.root, `test -e ${src} || { echo "shared source ${src} missing"; exit 1; }`, config, c);
      runInDir(paths.root, `mkdir -p "$(dirname ${dest})" && rm -rf ${dest} && ln -s ${src} ${dest}`, config, c);
    }
    steps.push('shared');

    // ---- Phase: install (inside the candidate; current still serving) ----
    st.phase = 'install';
    log.step('Installing dependencies in the candidate release');
    runInDir(st.releaseDir, `npm_config_cache=${paths.npmCache} ${config.hooks.install}`, config, c);
    steps.push('install');

    // ---- Phase: build (inside the candidate) ----
    if (config.hooks.build) {
      st.phase = 'build';
      log.step('Building the candidate release');
      runInDir(st.releaseDir, config.hooks.build, config, c);
      steps.push('build');
    }

    // ---- Phase: validate (candidate is now immutable) ----
    st.phase = 'validate';
    const builtSha = capture(st.releaseDir, 'git rev-parse HEAD', config, c);
    if (builtSha !== st.sha) throw new Error(`Candidate SHA ${builtSha} != resolved ${st.sha}`);
    for (const check of (config.layout.releaseChecks || [])) {
      log.step(`Release check: ${check.name}`);
      runInDir(st.releaseDir, check.command, config, c);
    }
    steps.push('validate');

    // ================= disruptive window opens =================
    if (!skipMigrate && config.dbBoundApps.length) {
      // Codex ordering: stop writers FIRST, THEN back up (consistent snapshot), THEN migrate.
      st.phase = 'stopped';
      log.step(`Pausing DB-bound apps (${config.dbBoundApps.join(', ')})`);
      runInDir(paths.root, `pm2 stop ${config.dbBoundApps.join(' ')} 2>/dev/null || true`, config, c, { tolerate: true });
      st.dbAppsPaused = true;
    }
    if (!skipMigrate && config.hooks.backup) {
      log.step('Backing up the database (writers stopped)');
      const res = runInDir(st.releaseDir, config.hooks.backup, config, c, { capture: true });
      if (!res.ok) throw new Error('Pre-migration database backup failed');
      st.backupId = (res.output || '').trim().split('\n').pop() || null;
      steps.push('backup');
    }
    if (!skipMigrate && config.hooks.migrate) {
      // Mark migrated BEFORE running: a migration that fails partway may have already
      // touched the schema, so recovery from here on must restore the DB, not just
      // resume the previous (possibly-incompatible) code.
      st.phase = 'migrated';
      st.migrated = true;
      log.step('Running database migrations');
      runInDir(st.releaseDir, config.hooks.migrate, config, c);
      steps.push('migrate');
    }

    // ---- Phase: flip (atomic activation) ----
    st.phase = 'flipped';
    // Record the known-good pointer, then flip.
    if (st.prevTarget) activateSymlink(config, paths, st.prevTarget, c, { link: paths.previousLink });
    activateSymlink(config, paths, `releases/${releaseId}`, c);
    st.flipped = true;
    steps.push('flip');

    log.step('Restarting apps from the stable ecosystem');
    runInDir(paths.root, pm2Activate(config, paths), config, c);
    runInDir(paths.root, 'pm2 save 2>/dev/null || true', config, c, { tolerate: true });

    // ---- Phase: verify ----
    st.phase = 'verify';
    const v = verifyActivation(config, paths, st.sha, st.releaseDir, c);
    if (!v.ok) throw new Error(`Activation verification failed: ${v.reason}`);
    steps.push('health');

    // ---- Phase: metadata + prune (success; still holding the lock) ----
    writeState(config, paths, { current: `releases/${releaseId}`, previous: st.prevTarget, sha: st.sha, backupId: st.backupId, ts }, c);
    prune(config, paths, releaseId, c);
    steps.push('prune');

    log.success(`Deployment completed successfully (release ${releaseId})`);
    return { branch, mode: config.mode, host: config.host, sha: st.sha, release: releaseId, steps, healthy: true };
  } catch (err) {
    recover(err);
    throw err;
  } finally {
    process.removeListener('SIGINT', sigHandlers.SIGINT);
    process.removeListener('SIGTERM', sigHandlers.SIGTERM);
    release();
  }
}

// Atomic symlink swap: create a uniquely-named temp symlink in the same directory,
// then GNU `mv -T` renames it over the target (a single namespace op on ext4 —
// readers see the old or new link, never a missing one). Relative target so the
// tree can be relocated. `link` overrides which symlink is written (current by default).
function activateSymlink(config, paths, relTarget, ctx, { link, tolerate = false } = {}) {
  const dest = link || paths.currentLink;
  const tmp = `${paths.root}/.dk-swap.$$.${dest.split('/').pop()}`;
  const cmd = `ln -s ${relTarget} ${tmp} && mv -Tf ${tmp} ${dest}`;
  const res = runOnTarget(cmd, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
  if (!res.ok) {
    runOnTarget(`rm -f ${tmp} 2>/dev/null || true`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
    if (!tolerate) throw new Error(`Deploy aborted: atomic symlink swap failed (${dest})`);
  }
}

// Persist explicit release metadata (never inferred). Written only after a verified
// activation, while the lock is held.
function writeState(config, paths, state, ctx) {
  const json = JSON.stringify({ ...state, layoutVersion: LAYOUT_VERSION }).replace(/'/g, "'\\''");
  runOnTarget(`printf '%s' '${json}' > ${paths.stateFile}`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
}

// Prune releases beyond keepReleases. Never removes current/previous or the just-
// activated release; only ever touches paths under releases/; uses git-aware
// removal. Runs post-activation holding the lock.
function prune(config, paths, keepId, ctx) {
  const keep = config.layout.keepReleases || 4;
  const pointers = readPointers(config, paths, ctx);
  const protectedIds = new Set([keepId,
    pointers.current && pointers.current.replace('releases/', ''),
    pointers.previous && pointers.previous.replace('releases/', '')].filter(Boolean));
  const listing = capture(paths.root, `ls -1 ${paths.releasesDir} 2>/dev/null || true`, config, ctx);
  const all = listing.split('\n').map((s) => s.trim()).filter(Boolean).sort(); // ts is fixed-width → lexical == chronological
  const removable = all.filter((id) => !protectedIds.has(id));
  const excess = removable.slice(0, Math.max(0, removable.length - Math.max(0, keep - 1)));
  for (const id of excess) {
    const dir = `${paths.releasesDir}/${id}`;
    ctx.log.step(`Pruning old release ${id}`);
    runOnTarget(`git --git-dir=${paths.repoGit} worktree remove --force ${dir} 2>/dev/null || rm -rf ${dir}`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
  }
  runOnTarget(`git --git-dir=${paths.repoGit} worktree prune 2>/dev/null || true`, { ...config, projectDir: paths.root }, { runtime: ctx.runtime });
}

// Release-layout rollback: flip `current` back to the recorded previous release and
// restart. NO reinstall/rebuild (the previous release is already built). Data is NOT
// touched — a schema rollback is a data-loss decision the operator makes explicitly.
function rollbackRelease(config, options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const c = { ...ctx, log, sleep, runtime: ctx.runtime };
  const paths = releasePaths(config);

  log.header(`⏪ Rolling back [release layout] (${config.mode}${config.host ? ` → ${config.host}` : ''})`);
  const release = acquireLock(config, c, { steal: options.stealLock === true });
  try {
    preflight(config, paths, c);
    const pointers = readPointers(config, paths, c);
    if (!pointers.previous) throw new Error(`No previous release recorded (${paths.previousLink}); cannot roll back.`);
    const target = capture(paths.root, `readlink -f ${paths.previousLink}`, config, c);
    if (!target) throw new Error('previous symlink does not resolve to a release directory.');

    log.step(`Flipping current back to ${pointers.previous}`);
    activateSymlink(config, paths, pointers.previous, c);
    runInDir(paths.root, pm2Activate(config, paths), config, c);
    runInDir(paths.root, 'pm2 save 2>/dev/null || true', config, c, { tolerate: true });

    const v = verifyActivation(config, paths, null, `${paths.root}/${pointers.previous}`, c);
    if (!v.ok) throw new Error(`Rollback flip verification failed: ${v.reason}`);

    log.success(`Rolled back to ${pointers.previous}`);
    if (config.hooks.backup) {
      log.warning('Code rolled back to the previous release. If the failed deploy ran a migration, the previous '
        + 'code may not run against the migrated schema — restore the pre-migration DB backup explicitly if needed.');
    }
    return { release: pointers.previous, mode: config.mode, host: config.host, healthy: true };
  } finally {
    release();
  }
}

module.exports = {
  LAYOUT_VERSION,
  isReleaseLayout,
  releasePaths,
  deployRelease,
  rollbackRelease,
  verifyActivation,
  activateSymlink,
  prune,
  readPointers,
};

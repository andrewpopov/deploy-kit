'use strict';

const { runOnTarget, buildHealthCommand } = require('./exec');
const { lockDir, prevShaFile, acquireLock } = require('./lock');
const { log: defaultLog } = require('./log');
const { backupIdFromOutput, backupReferenceFromId } = require('./backup-reference');

function defaultSleep(seconds) {
  const ms = seconds * 1000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Path to the host layout marker. A legacy deploy/rollback must refuse to run
// against a host that has been migrated to the release layout (SMH-112) — pulling
// and building in a bare/releases root would be destructive. Cheap single probe.
function layoutMarkerFile(config) {
  return `${config.projectDir}/.deploy-kit-layout`;
}

// Abort a legacy (non-release-layout) deploy/rollback if the host is already on
// the release layout but the config forgot its `layout` block. Fails closed.
function assertNotReleaseHost(config, ctx) {
  if (!config.projectDir) return;
  const res = runOnTarget(
    `test -f ${layoutMarkerFile(config)} && echo RELEASE || true`,
    config,
    { capture: true, runtime: ctx.runtime },
  );
  if ((res.output || '').trim() === 'RELEASE') {
    throw new Error(
      `Host ${config.projectDir} is on the release layout (found .deploy-kit-layout) but this config has no `
      + `"layout" block. Refusing to run a legacy in-place deploy against a release-layout host. Add the `
      + `layout config, or run against the correct target.`,
    );
  }
}

// Resolve the deploy branch: explicit config wins, else the target's origin/HEAD,
// else 'master' (matches bewks resolve_deploy_branch).
function resolveBranch(config, ctx) {
  if (config.branch) return config.branch;
  const res = runOnTarget(
    `git rev-parse --abbrev-ref ${config.remote}/HEAD 2>/dev/null || true`,
    config,
    { capture: true, runtime: ctx.runtime },
  );
  const ref = (res.output || '').trim().replace(`${config.remote}/`, '');
  return ref || 'master';
}

// The set of endpoints to health-gate: the scalar port/healthPath is always
// probed; healthChecks adds extra endpoints (app + worker fleets).
function healthEndpoints(config) {
  return [{}, ...(config.healthChecks || [])];
}

// Poll the app's health endpoint(s) on the target until each returns 200 or
// attempts are exhausted. In ssh mode curl runs on the remote (localhost:port).
function waitForHealth(config, ctx) {
  const { attempts, delaySeconds } = config.health;
  for (const check of healthEndpoints(config)) {
    const label = check.path || check.port ? ` (${check.port || config.port}${check.path || config.healthPath})` : '';
    const command = buildHealthCommand(config, check);
    let ok = false;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const res = runOnTarget(command, config, { capture: true, runtime: ctx.runtime });
      const code = (res.output || '').trim();
      if (code === '200') {
        ctx.log.success(`Application is healthy (HTTP 200)${label} after ${attempt} attempt(s)`);
        ok = true;
        break;
      }
      ctx.log.info(`Health not ready${label} (HTTP ${code || '000'}); retry in ${delaySeconds}s (${attempt}/${attempts})`);
      if (attempt < attempts) ctx.sleep(delaySeconds);
    }
    if (!ok) return false;
  }
  return true;
}

// Build the PM2 (re)start command for one or more process names. With an
// `ecosystemFile`, start from the file when a process isn't registered yet (first
// deploy) and fall back to `pm2 restart` when it is — the proven
// `pm2 start <file> --only <name> --update-env || pm2 restart <name> --update-env`
// idiom from the
// hand-rolled deploy.sh (sano). Without a file, plain `pm2 restart <names>`
// (requires the processes to already exist, matching the original default).
function pm2StartOrRestart(names, config) {
  const list = Array.isArray(names) ? names : [names];
  const restart = `pm2 restart ${list.join(' ')} --update-env`;
  if (!config.ecosystemFile) return restart;
  return `pm2 start ${config.ecosystemFile} --only ${list.join(',')} --update-env 2>/dev/null || ${restart}`;
}

// A step that must succeed or the whole deploy aborts. onFail runs first
// (e.g. restart the apps we paused) so we never leave services stopped.
function gate(step, config, ctx, { onFail, capture = false } = {}) {
  ctx.log.step(step.message);
  const res = runOnTarget(step.command, config, { runtime: ctx.runtime, capture });
  if (!res.ok) {
    if (onFail) onFail();
    throw new Error(`Deploy aborted: ${step.message} failed`);
  }
  return res;
}

// Run the full pipeline on the target. Returns a structured summary. Throws on
// any gated failure (caller/CLI maps that to a non-zero exit).
//
// Sequence (faithful to the hand-rolled bewks/kira/smarthome deploy.sh):
//   lock → checks → stash → record-SHA → fetch → pull --ff-only → drop-stash →
//   install → BACKUP(gate) → stop db-bound apps (release SQLite lock) →
//   migrate(gate, restart on fail) → build → restart apps → health(gate)
function deploy(config, options = {}, ctx = {}) {
  // Artifact-first release layout (SMH-112) is a separate pipeline. Lazy-require to
  // avoid a top-level cycle (release.js pulls shared helpers, not this module).
  if (config.layout && config.layout.type === 'releases') {
    return require('./release').deployRelease(config, options, ctx);
  }
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const runtime = ctx.runtime;
  const c = { ...ctx, log, sleep, runtime };
  const {
    skipDeps = false,
    skipBuild = false,
    skipMigrate = false,
    stash = config.mode !== 'local',
    stealLock = false,
    // Build while apps are still UP, before the backup/stop/migrate block, to keep
    // the app-paused window down to just migration (some repos, e.g. stoki, build
    // first then stop only for the DB work). Default false = build after migrate,
    // while apps are paused (bewks' model). Option or config both work.
    buildBeforeMigrate = config.buildBeforeMigrate === true,
  } = options;

  const run = (message, command, opts) => {
    log.step(message);
    const res = runOnTarget(command, config, { runtime, input: opts?.input });
    if (!res.ok && !opts?.tolerate) throw new Error(`Deploy aborted: ${message} failed`);
    return res.ok;
  };

  log.header(`🚀 Deploying (${config.mode}${config.host ? ` → ${config.host}` : ''})`);
  const branch = resolveBranch(config, c);
  const steps = [];
  let backupId = null;

  const release = acquireLock(config, c, { steal: stealLock });
  try {
    // Fail closed if the host was migrated to the release layout but this config
    // still asks for a legacy in-place deploy.
    assertNotReleaseHost(config, c);
    // Pre-deploy checks: user-defined gates run BEFORE anything is touched (no stash,
    // fetch, or pull yet). Each is a command on the target; a non-zero exit aborts the
    // deploy with nothing changed. Use for preconditions — free disk, DB reachable,
    // a required env var present. Generic: the kit runs them, the consumer supplies them.
    for (const check of config.preDeployChecks) {
      gate({ message: `Pre-deploy check: ${check.name}`, command: check.command }, config, c);
      steps.push(`check:${check.name}`);
    }

    if (stash) {
      // Tracked-only stash: never sweep untracked .ssh/.cloudflared into a stash —
      // that would break the tunnel and lose the key mid-deploy.
      run('Stashing local tracked changes', `git stash push -m "deploy-kit $(date -u +%FT%TZ)" || true`, { tolerate: true });
      steps.push('stash');
    }

    // Record the current SHA before pulling so `deploy-kit rollback` can reset to
    // the exact code that was live before this deploy.
    run('Recording current revision', `git rev-parse HEAD > ${prevShaFile(config)} 2>/dev/null || true`, { tolerate: true });

    run('Fetching latest', `git fetch ${config.remote} --prune`);
    run(`Pulling ${config.remote}/${branch} (--ff-only)`, `git pull --ff-only ${config.remote} ${branch}`);
    steps.push(`pull:${branch}`);

    if (stash) {
      // Drop the stash we just created (matched by our marker) so tracked-change
      // stashes don't pile up on the target across deploys. Only ever drops a
      // deploy-kit stash; a hand-made stash is left untouched.
      run('Dropping deploy stash (if any)',
        `ref=$(git stash list --format='%gd %gs' | grep -m1 'deploy-kit' | awk '{print $1}'); if [ -n "$ref" ]; then git stash drop "$ref"; fi`,
        { tolerate: true });
    }

    if (!skipDeps) {
      run('Installing dependencies', config.hooks.install);
      steps.push('install');
    }

    // Once the DB-bound apps are paused for migration, EVERY subsequent step
    // (migrate, build) must bring them back up on failure — otherwise a build
    // error leaves production stopped. Matches deploy.sh, which `pm2 start`s the
    // paused apps on every post-stop failure before aborting.
    let dbAppsPaused = false;
    const resumeDbApps = () => {
      if (dbAppsPaused && config.dbBoundApps.length) {
        runOnTarget(`pm2 start ${config.dbBoundApps.join(' ')} 2>/dev/null || true`, config, { runtime });
        dbAppsPaused = false;
      }
    };
    // A gated step that, on failure, first resumes any paused apps, then aborts.
    const safeStep = (message, command) => {
      gate({ message, command }, config, c, { onFail: resumeDbApps });
    };

    const doBuild = !skipBuild && config.hooks.build;

    if (buildBeforeMigrate && doBuild) {
      // Build with apps still up — no pause yet, so a build failure aborts without
      // any service having been stopped.
      run('Building', config.hooks.build);
      steps.push('build');
    }

    if (!skipMigrate) {
      if (config.hooks.backup) {
        // Backup BEFORE migrating; a failed backup aborts before any schema change
        // (apps are still running here, so no resume needed).
        const backup = gate(
          { message: 'Pre-migration database backup', command: config.hooks.backup },
          config,
          c,
          { capture: true },
        );
        // Capture is required to correlate the backup with the delivery event.
        // Replay stdout so legacy hooks retain their operator-visible output.
        for (const line of (backup.output || '').split('\n').filter(Boolean)) log.info(line);
        backupId = backupIdFromOutput(backup.output);
        steps.push('backup');
      }
      if (config.dbBoundApps.length) {
        // Stop DB-bound processes so they release the SQLite lock before migrate.
        run(`Pausing DB-bound apps (${config.dbBoundApps.join(', ')})`,
          `pm2 stop ${config.dbBoundApps.join(' ')} 2>/dev/null || true`, { tolerate: true });
        dbAppsPaused = true;
      }
      if (config.hooks.migrate) {
        safeStep('Running database migrations', config.hooks.migrate);
        steps.push('migrate');
      }
    }

    if (!buildBeforeMigrate && doBuild) {
      // Default: build while apps are paused (bewks' model); resume-on-failure so a
      // broken build never leaves the fleet stopped.
      safeStep('Building', config.hooks.build);
      steps.push('build');
    }

    // Pre-restart checks: gated, run IMMEDIATELY BEFORE the restart step — after
    // build, with any dbBoundApps still paused. A failure here resumes paused apps
    // first (safeStep), same contract as a failed build in this window. Generic:
    // the kit runs them, the consumer supplies them (e.g. a port-conflict guard
    // against the freshly-built candidate before it takes over the port).
    for (const check of config.preRestartChecks) {
      safeStep(`Pre-restart check: ${check.name}`, check.command);
      steps.push(`pre-restart-check:${check.name}`);
    }

    if (config.appNames.length) {
      const restartCmd = config.hooks.restart || pm2StartOrRestart(config.appNames, config);
      run(`Restarting apps (${config.appNames.join(', ')})`, restartCmd);
      dbAppsPaused = false;
      steps.push('restart');

      // Ensure auxiliary PM2 processes are up after the main restart — a cloudflared
      // tunnel, a sidecar worker, anything that isn't the health-gated app. Generic
      // and tolerant: a process that's already running, or briefly flaps, must never
      // fail an otherwise-healthy deploy. Not a tunnel-specific concept.
      for (const name of config.ensureApps) {
        run(`Ensuring ${name}`, pm2StartOrRestart(name, config), { tolerate: true });
      }
      if (config.ensureApps.length) steps.push('ensure');

      run('Persisting PM2 process list', 'pm2 save 2>/dev/null || true', { tolerate: true });
    }

    const healthy = waitForHealth(config, c);
    if (!healthy) {
      throw new Error('Deploy completed but the application is unhealthy');
    }
    steps.push('health');

    for (const check of config.postDeployChecks) {
      gate({ message: `Post-deploy check: ${check.name}`, command: check.command }, config, c);
      steps.push(`post-check:${check.name}`);
    }

    if (config.deliveryEvent?.command) {
      const backupReference = backupReferenceFromId(backupId);
      const payload = JSON.stringify({
        event: 'deployment', status: 'succeeded', branch,
        revision: runOnTarget('git rev-parse HEAD', config, { runtime, capture: true }).output.trim(),
        deployedAt: new Date().toISOString(),
        ...(backupReference ? { backupReference } : {}),
      });
      run('Emitting delivery event', config.deliveryEvent.command, { tolerate: true, input: payload });
      steps.push('delivery-event');
    }

    log.success('Deployment completed successfully');
    return { branch, mode: config.mode, host: config.host, steps, healthy };
  } finally {
    release();
  }
}

// Roll the target back to the revision recorded before the last deploy:
// `git reset --hard <prev SHA>` + reinstall + rebuild + restart. Data is NOT
// touched — we print the matching `db-backup restore` command instead of
// auto-restoring, since a schema rollback is the operator's call.
function rollback(config, options = {}, ctx = {}) {
  // Release-layout rollback is a symlink flip to the previous release, not a git
  // reset — a different pipeline. Legacy rollback must refuse a release-layout host.
  if (config.layout && config.layout.type === 'releases') {
    return require('./release').rollbackRelease(config, options, ctx);
  }
  const log = ctx.log || defaultLog;
  const runtime = ctx.runtime;
  const c = { ...ctx, log, sleep: ctx.sleep || defaultSleep, runtime };

  log.header(`⏪ Rolling back (${config.mode}${config.host ? ` → ${config.host}` : ''})`);

  // Lock first, THEN read the recorded SHA — otherwise a concurrent deploy could
  // rewrite the file between our read and the lock, resetting to the wrong SHA.
  const release = acquireLock(config, c, { steal: options.stealLock === true });
  try {
    // Fail closed if the host is on the release layout (legacy git-reset rollback
    // would be destructive there).
    assertNotReleaseHost(config, c);
    const prev = runOnTarget(`cat ${prevShaFile(config)} 2>/dev/null || true`, config, { capture: true, runtime });
    const sha = (prev.output || '').trim();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) {
      throw new Error(`No recorded previous revision (${prevShaFile(config)}); cannot roll back automatically.`);
    }

    const run = (message, command, opts) => {
      log.step(message);
      const res = runOnTarget(command, config, { runtime });
      if (!res.ok && !opts?.tolerate) throw new Error(`Rollback aborted: ${message} failed`);
      return res.ok;
    };

    run(`Resetting to ${sha.slice(0, 12)}`, `git reset --hard ${sha}`);
    if (!options.skipDeps) run('Installing dependencies', config.hooks.install);
    if (!options.skipBuild && config.hooks.build) run('Building', config.hooks.build);
    // Same gate as the forward deploy, immediately before restart — a rollback
    // restart is just as capable of colliding with a squatting process as a
    // forward one, so the guard must cover both.
    for (const check of config.preRestartChecks) {
      run(`Pre-restart check: ${check.name}`, check.command);
    }
    if (config.appNames.length) {
      run(`Restarting apps (${config.appNames.join(', ')})`, config.hooks.restart || pm2StartOrRestart(config.appNames, config));
      for (const name of config.ensureApps) {
        run(`Ensuring ${name}`, pm2StartOrRestart(name, config), { tolerate: true });
      }
      run('Persisting PM2 process list', 'pm2 save 2>/dev/null || true', { tolerate: true });
    }

    const healthy = waitForHealth(config, c);
    if (!healthy) throw new Error('Rollback completed but the application is unhealthy');

    log.success(`Rolled back to ${sha.slice(0, 12)}`);
    if (config.hooks.backup) {
      log.warning('Code rolled back. If the failed deploy ran a migration, restore data with your db-backup restore command (e.g. `npx db-backup restore --prod`).');
    }
    return { sha, mode: config.mode, host: config.host, healthy };
  } finally {
    release();
  }
}

module.exports = { deploy, rollback, resolveBranch, waitForHealth, lockDir, prevShaFile };

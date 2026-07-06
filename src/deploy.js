'use strict';

const { runOnTarget } = require('./exec');
const { log: defaultLog } = require('./log');

function defaultSleep(seconds) {
  const ms = seconds * 1000;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

// Poll the app's health endpoint on the target until it returns 200 or attempts
// are exhausted. In ssh mode curl runs on the remote (localhost:port).
function waitForHealth(config, ctx) {
  const { attempts, delaySeconds } = config.health;
  const url = `http://localhost:${config.port}${config.healthPath}`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = runOnTarget(
      `curl -f -s ${url} -o /dev/null -w '%{http_code}'`,
      config,
      { capture: true, runtime: ctx.runtime },
    );
    const code = (res.output || '').trim();
    if (code === '200') {
      ctx.log.success(`Application is healthy (HTTP 200) after ${attempt} attempt(s)`);
      return true;
    }
    ctx.log.info(`Health not ready (HTTP ${code || '000'}); retry in ${delaySeconds}s (${attempt}/${attempts})`);
    if (attempt < attempts) ctx.sleep(delaySeconds);
  }
  return false;
}

// Build the PM2 (re)start command for one or more process names. With an
// `ecosystemFile`, start from the file when a process isn't registered yet (first
// deploy) and fall back to `pm2 restart` when it is — the proven
// `pm2 start <file> --only <name> || pm2 restart <name>` idiom from the
// hand-rolled deploy.sh (sano). Without a file, plain `pm2 restart <names>`
// (requires the processes to already exist, matching the original default).
function pm2StartOrRestart(names, config) {
  const list = Array.isArray(names) ? names : [names];
  const restart = `pm2 restart ${list.join(' ')}`;
  if (!config.ecosystemFile) return restart;
  return `pm2 start ${config.ecosystemFile} --only ${list.join(',')} 2>/dev/null || ${restart}`;
}

// A step that must succeed or the whole deploy aborts. onFail runs first
// (e.g. restart the apps we paused) so we never leave services stopped.
function gate(step, config, ctx, { onFail } = {}) {
  ctx.log.step(step.message);
  const res = runOnTarget(step.command, config, { runtime: ctx.runtime });
  if (!res.ok) {
    if (onFail) onFail();
    throw new Error(`Deploy aborted: ${step.message} failed`);
  }
}

// Run the full pipeline on the target. Returns a structured summary. Throws on
// any gated failure (caller/CLI maps that to a non-zero exit).
//
// Sequence (faithful to the hand-rolled bewks/kira/smarthome deploy.sh):
//   stash → fetch → pull --ff-only → install → BACKUP(gate) →
//   stop db-bound apps (release SQLite lock) → migrate(gate, restart on fail) →
//   build → restart apps → health(gate)
function deploy(config, options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const sleep = ctx.sleep || defaultSleep;
  const runtime = ctx.runtime;
  const c = { ...ctx, log, sleep, runtime };
  const {
    skipDeps = false,
    skipBuild = false,
    skipMigrate = false,
    stash = config.mode !== 'local',
    force = false,
    // Build while apps are still UP, before the backup/stop/migrate block, to keep
    // the app-paused window down to just migration (some repos, e.g. stoki, build
    // first then stop only for the DB work). Default false = build after migrate,
    // while apps are paused (bewks' model). Option or config both work.
    buildBeforeMigrate = config.buildBeforeMigrate === true,
  } = options;

  const run = (message, command, opts) => {
    log.step(message);
    const res = runOnTarget(command, config, { runtime });
    if (!res.ok && !opts?.tolerate) throw new Error(`Deploy aborted: ${message} failed`);
    return res.ok;
  };

  log.header(`🚀 Deploying (${config.mode}${config.host ? ` → ${config.host}` : ''})`);
  const branch = resolveBranch(config, c);
  const steps = [];

  if (stash) {
    // Tracked-only stash: never sweep untracked .ssh/.cloudflared into a stash —
    // that would break the tunnel and lose the key mid-deploy.
    run('Stashing local tracked changes', `git stash push -m "deploy-kit $(date -u +%FT%TZ)" || true`, { tolerate: true });
    steps.push('stash');
  }

  run('Fetching latest', `git fetch ${config.remote} --prune`);
  run(`Pulling ${config.remote}/${branch} (--ff-only)`, `git pull --ff-only ${config.remote} ${branch}`);
  steps.push(`pull:${branch}`);

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
      gate({ message: 'Pre-migration database backup', command: config.hooks.backup }, config, c);
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

  if (config.appNames.length) {
    const restartCmd = config.hooks.restart || pm2StartOrRestart(config.appNames, config);
    run(`Restarting apps (${config.appNames.join(', ')})`, restartCmd);
    dbAppsPaused = false;
    steps.push('restart');

    if (config.ensureTunnelOnDeploy && config.tunnelName) {
      // Bring the cloudflared tunnel up if it isn't already (tolerant — a tunnel
      // that's already running, or briefly flaps, must never fail an otherwise
      // healthy deploy). Mirrors deploy.sh's `pm2 start ... --only <tunnel> ||
      // pm2 restart <tunnel> || true` tail.
      run(`Ensuring tunnel (${config.tunnelName})`,
        pm2StartOrRestart(config.tunnelName, config), { tolerate: true });
      steps.push('tunnel');
    }

    run('Persisting PM2 process list', 'pm2 save 2>/dev/null || true', { tolerate: true });
  }

  const healthy = waitForHealth(config, c);
  if (!healthy) {
    throw new Error('Deploy completed but the application is unhealthy');
  }
  steps.push('health');

  log.success('Deployment completed successfully');
  return { branch, mode: config.mode, host: config.host, steps, healthy };
}

module.exports = { deploy, resolveBranch, waitForHealth };

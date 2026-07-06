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

  if (!skipMigrate) {
    if (config.hooks.backup) {
      // Backup BEFORE migrating; a failed backup aborts before any schema change.
      gate({ message: 'Pre-migration database backup', command: config.hooks.backup }, config, c);
      steps.push('backup');
    }
    const restartDbApps = () => {
      if (config.dbBoundApps.length) {
        runOnTarget(`pm2 restart ${config.dbBoundApps.join(' ')}`, config, { runtime });
      }
    };
    if (config.dbBoundApps.length) {
      // Stop DB-bound processes so they release the SQLite lock before migrate.
      run(`Pausing DB-bound apps (${config.dbBoundApps.join(', ')})`,
        `pm2 stop ${config.dbBoundApps.join(' ')} 2>/dev/null || true`, { tolerate: true });
    }
    if (config.hooks.migrate) {
      gate({ message: 'Running database migrations', command: config.hooks.migrate }, config, c, { onFail: restartDbApps });
      steps.push('migrate');
    }
  }

  if (!skipBuild && config.hooks.build) {
    run('Building', config.hooks.build);
    steps.push('build');
  }

  if (config.appNames.length) {
    const restartCmd = config.hooks.restart || `pm2 restart ${config.appNames.join(' ')}`;
    run(`Restarting apps (${config.appNames.join(', ')})`, restartCmd);
    run('Persisting PM2 process list', 'pm2 save 2>/dev/null || true', { tolerate: true });
    steps.push('restart');
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

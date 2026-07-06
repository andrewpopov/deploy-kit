'use strict';

const { runOnTarget, buildHealthCommand } = require('./exec');
const { log: defaultLog } = require('./log');

// Config-driven remote ops, generalized from bewks scripts/tools/remote-agent.js.
// Uses PM2 app names directly (not `npm run pm2:*`) so it works without the app
// declaring wrapper scripts. Every verb runs on the target (ssh or local).

function health(config, ctx = {}) {
  const log = ctx.log || defaultLog;
  const res = runOnTarget(
    buildHealthCommand(config),
    config,
    { capture: true, runtime: ctx.runtime },
  );
  const code = (res.output || '').trim();
  if (code === '200') {
    log.success('Application is healthy (HTTP 200)');
    return true;
  }
  log.warning(`Health check returned: ${code || 'No response'}`);
  return false;
}

const allApps = (config) =>
  [...new Set([...config.appNames, ...(config.ensureApps || []), config.tunnelName].filter(Boolean))];

function status(config, ctx = {}) {
  (ctx.log || defaultLog).header('📊 Status');
  return runOnTarget('pm2 status', config, { runtime: ctx.runtime }).ok;
}

function logs(config, options = {}, ctx = {}) {
  const { lines = 50, follow = false, errors = false } = options;
  const targets = config.appNames.join(' ') || 'all';
  let cmd = `pm2 logs ${targets}`;
  if (errors) cmd += ' --err';
  cmd += follow ? ' --raw' : ` --lines ${lines} --nostream`;
  return runOnTarget(cmd, config, { runtime: ctx.runtime }).ok;
}

function lifecycle(action, config, ctx = {}) {
  const log = ctx.log || defaultLog;
  const apps = config.appNames.join(' ');
  if (!apps) {
    log.error('No appNames configured');
    return false;
  }
  log.header(`${action} ${apps}`);
  const ok = runOnTarget(`pm2 ${action} ${apps}`, config, { runtime: ctx.runtime }).ok;
  if (ok) runOnTarget('pm2 save 2>/dev/null || true', config, { runtime: ctx.runtime });
  return ok;
}

const start = (config, ctx) => lifecycle('start', config, ctx);
const stop = (config, ctx) => lifecycle('stop', config, ctx);
const restart = (config, ctx) => lifecycle('restart', config, ctx);

function resources(config, ctx = {}) {
  const log = ctx.log || defaultLog;
  log.header('💻 System Resources');
  runOnTarget('free -h', config, { runtime: ctx.runtime });
  runOnTarget('df -h | grep -E "^/dev|Filesystem"', config, { runtime: ctx.runtime });
  runOnTarget('uptime', config, { runtime: ctx.runtime });
  return true;
}

function gitInfo(config, ctx = {}) {
  (ctx.log || defaultLog).header('🔍 Git');
  runOnTarget('git rev-parse --abbrev-ref HEAD', config, { runtime: ctx.runtime });
  runOnTarget('git log -1 --oneline', config, { runtime: ctx.runtime });
  runOnTarget('git status --short', config, { runtime: ctx.runtime });
  return true;
}

function dashboard(config, ctx = {}) {
  const log = ctx.log || defaultLog;
  log.header('📊 Management Dashboard');
  status(config, ctx);
  log.divider();
  health(config, ctx);
  log.divider();
  gitInfo(config, ctx);
  return true;
}

module.exports = {
  health, status, logs, start, stop, restart, resources, gitInfo, dashboard, allApps,
};

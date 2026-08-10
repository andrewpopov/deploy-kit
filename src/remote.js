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

// Each of these runs several read-only inspection commands and used to
// discard every result and return true unconditionally -- so `resources`/
// `git` exited 0 even when the SSH connection failed and nothing was actually
// inspected. Honor `runOnTarget`'s `.ok` instead: true only when every
// command in the group actually ran and exited zero.
function resources(config, ctx = {}) {
  const log = ctx.log || defaultLog;
  log.header('💻 System Resources');
  const memOk = runOnTarget('free -h', config, { runtime: ctx.runtime }).ok;
  const diskOk = runOnTarget('df -h | grep -E "^/dev|Filesystem"', config, { runtime: ctx.runtime }).ok;
  const uptimeOk = runOnTarget('uptime', config, { runtime: ctx.runtime }).ok;
  return memOk && diskOk && uptimeOk;
}

function gitInfo(config, ctx = {}) {
  (ctx.log || defaultLog).header('🔍 Git');
  const branchOk = runOnTarget('git rev-parse --abbrev-ref HEAD', config, { runtime: ctx.runtime }).ok;
  const logOk = runOnTarget('git log -1 --oneline', config, { runtime: ctx.runtime }).ok;
  const statusOk = runOnTarget('git status --short', config, { runtime: ctx.runtime }).ok;
  return branchOk && logOk && statusOk;
}

// Composes status + health + gitInfo -- must fail if any of them does, not
// just print all three and claim success regardless.
function dashboard(config, ctx = {}) {
  const log = ctx.log || defaultLog;
  log.header('📊 Management Dashboard');
  const statusOk = status(config, ctx);
  log.divider();
  const healthOk = health(config, ctx);
  log.divider();
  const gitOk = gitInfo(config, ctx);
  return statusOk && healthOk && gitOk;
}

module.exports = {
  health, status, logs, start, stop, restart, resources, gitInfo, dashboard, allApps,
};

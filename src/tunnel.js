'use strict';

const { execFileSync: nodeExecFileSync } = require('child_process');
const fs = require('fs');
const { log: defaultLog } = require('./log');

// Launch a Cloudflare tunnel from a config file, generalized from the per-repo
// start-tunnel.js wrappers. Runs `cloudflared tunnel --config <file> run <name>`
// in the foreground (PM2 keeps it alive in production).
function startTunnel(options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const execFileSync = ctx.execFileSync || nodeExecFileSync;
  const fsImpl = ctx.fs || fs;
  const { configPath, tunnelName, cloudflaredBin = 'cloudflared' } = options;

  if (!configPath) throw new Error('startTunnel: `configPath` is required');
  if (!tunnelName) throw new Error('startTunnel: `tunnelName` is required');
  if (!fsImpl.existsSync(configPath)) {
    throw new Error(`Tunnel config not found: ${configPath}`);
  }

  const args = ['tunnel', '--config', configPath, 'run', tunnelName];
  log.step(`Starting tunnel ${tunnelName} (${configPath})`);
  // Deliberately unbounded (the one exception to the bound-every-command rule):
  // this call IS the long-running tunnel process, not a step that should finish.
  // A timeout here would kill the tunnel it just started.
  execFileSync(cloudflaredBin, args, { stdio: 'inherit' });
  return { tunnelName, configPath, args };
}

module.exports = { startTunnel };

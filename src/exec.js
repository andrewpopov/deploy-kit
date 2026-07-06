'use strict';

const { execFileSync: nodeExecFileSync } = require('child_process');

// Runtime seam so deploy/remote logic is unit-testable: tests inject a fake
// execFileSync and assert the exact command stream (no real ssh/pm2 needed).
function normalizeRuntime(runtime = {}) {
  return {
    execFileSync: runtime.execFileSync || nodeExecFileSync,
  };
}

// Wrap a command so it runs on the target. In 'ssh' mode we `cd` into the
// project dir first (matching the hand-rolled `ssh host "cd dir && cmd"` idiom);
// in 'local' mode (script runs on the box, e.g. sano) we run it directly.
function buildTargetCommand(command, { mode, host, projectDir }) {
  if (mode === 'local') {
    const prefix = projectDir ? `cd ${projectDir} && ` : '';
    return { file: 'sh', args: ['-c', `${prefix}${command}`] };
  }
  if (!host) {
    throw new Error('deploy-kit: mode "ssh" requires a `host` (user@host)');
  }
  const remote = projectDir ? `cd ${projectDir} && ${command}` : command;
  return { file: 'ssh', args: [host, remote] };
}

// Run one command on the target. Returns { ok, output }. With capture:false the
// child inherits stdio (live logs); with capture:true stdout is returned.
function runOnTarget(command, config, { capture = false, runtime } = {}) {
  const { execFileSync } = normalizeRuntime(runtime);
  const { file, args } = buildTargetCommand(command, config);
  try {
    const output = execFileSync(file, args, {
      encoding: 'utf8',
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return { ok: true, output: capture ? String(output || '') : '' };
  } catch (error) {
    return { ok: false, output: capture ? String(error.stdout || '') : '', error };
  }
}

// Build the health-probe curl for a config, including any healthHeaders. Apps
// behind a TLS-terminating proxy that force-redirect plain http (e.g. an Express
// `res.redirect(301, https://…)`) return 301 to a direct localhost curl; sending
// `X-Forwarded-Proto: https` via healthHeaders makes them serve the real 200.
function buildHealthCommand(config) {
  const headerArgs = Object.entries(config.healthHeaders || {})
    .map(([key, value]) => `-H '${key}: ${value}'`)
    .join(' ');
  const url = `http://localhost:${config.port}${config.healthPath}`;
  return `curl -f -s ${headerArgs ? `${headerArgs} ` : ''}${url} -o /dev/null -w '%{http_code}'`;
}

module.exports = { normalizeRuntime, buildTargetCommand, runOnTarget, buildHealthCommand };

'use strict';

const { execFileSync: nodeExecFileSync } = require('child_process');

// Runtime seam so deploy/remote logic is unit-testable: tests inject a fake
// execFileSync and assert the exact command stream (no real ssh/pm2 needed).
function normalizeRuntime(runtime = {}) {
  return {
    execFileSync: runtime.execFileSync || nodeExecFileSync,
  };
}

// Build the `-o Key=Value` ssh hardening flags from config. Defaults harden
// against a wedged route hanging the deploy: ConnectTimeout bounds the connect,
// ServerAlive* detects a dead session mid-command. Each is opt-out (null omits).
function sshHardeningArgs(ssh = {}) {
  const args = [];
  if (ssh.connectTimeout != null) args.push('-o', `ConnectTimeout=${ssh.connectTimeout}`);
  if (ssh.serverAliveInterval != null) args.push('-o', `ServerAliveInterval=${ssh.serverAliveInterval}`);
  if (ssh.serverAliveCountMax != null) args.push('-o', `ServerAliveCountMax=${ssh.serverAliveCountMax}`);
  for (const opt of ssh.options || []) args.push('-o', opt);
  return args;
}

// Wrap a command so it runs on the target. In 'ssh' mode we `cd` into the
// project dir first (matching the hand-rolled `ssh host "cd dir && cmd"` idiom)
// and add connect/keepalive timeouts; in 'local' mode (script runs on the box,
// e.g. sano) we run it directly.
function buildTargetCommand(command, { mode, host, projectDir, ssh }) {
  if (mode === 'local') {
    const prefix = projectDir ? `cd ${projectDir} && ` : '';
    return { file: 'sh', args: ['-c', `${prefix}${command}`] };
  }
  if (!host) {
    throw new Error('deploy-kit: mode "ssh" requires a `host` (user@host)');
  }
  const remote = projectDir ? `cd ${projectDir} && ${command}` : command;
  return { file: 'ssh', args: [...sshHardeningArgs(ssh), host, remote] };
}

// Run one command on the target. Returns { ok, output }. With capture:false the
// child inherits stdio (live logs); with capture:true stdout is returned.
function runOnTarget(command, config, { capture = false, runtime } = {}) {
  const { execFileSync } = normalizeRuntime(runtime);
  const { file, args } = buildTargetCommand(command, config);
  const execOptions = {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  };
  // Kill a hung remote command instead of blocking the pipeline forever.
  if (config.stepTimeoutSeconds) execOptions.timeout = config.stepTimeoutSeconds * 1000;
  try {
    const output = execFileSync(file, args, execOptions);
    return { ok: true, output: capture ? String(output || '') : '' };
  } catch (error) {
    return { ok: false, output: capture ? String(error.stdout || '') : '', error };
  }
}

// Header key and value are single-quoted into the curl command with no escaping,
// so a literal single quote in either would break the quoting. Reject early
// (fail-fast on a config typo) rather than emit a subtly broken probe.
function assertSafeHeader(key, value) {
  if (String(key).includes("'") || String(value).includes("'")) {
    throw new Error(`deploy-kit: healthHeaders["${key}"] key/value must not contain a single quote`);
  }
}

// Build the health-probe curl for a config, including any healthHeaders. Apps
// behind a TLS-terminating proxy that force-redirect plain http (e.g. an Express
// `res.redirect(301, https://…)`) return 301 to a direct localhost curl; sending
// `X-Forwarded-Proto: https` via healthHeaders makes them serve the real 200.
//
// Pass a `check` ({ port?, path?, headers? }) to probe a secondary endpoint
// (app + worker fleets); omitted fields fall back to the scalar config.
function buildHealthCommand(config, check = {}) {
  const port = check.port != null ? check.port : config.port;
  const healthPath = check.path != null ? check.path : config.healthPath;
  const headers = check.headers != null ? check.headers : config.healthHeaders;
  const headerArgs = Object.entries(headers || {})
    .map(([key, value]) => {
      assertSafeHeader(key, value);
      return `-H '${key}: ${value}'`;
    })
    .join(' ');
  // Single-quote the URL so a healthPath with shell metacharacters (e.g.
  // `?a=1&b=2`) can't background/truncate the curl on the remote shell.
  const url = `'http://localhost:${port}${healthPath}'`;
  return `curl -f -s ${headerArgs ? `${headerArgs} ` : ''}${url} -o /dev/null -w '%{http_code}'`;
}

module.exports = {
  normalizeRuntime, buildTargetCommand, sshHardeningArgs, runOnTarget, buildHealthCommand,
};

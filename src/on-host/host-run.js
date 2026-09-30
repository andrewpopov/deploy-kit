'use strict';

// `deploy-kit host-run <runDir>` (PKG-187): the HOST side of `deploy --on-host`.
// It runs inside a transient systemd user unit, validates everything the
// operator staged in <runDir>, then runs deployRelease() in local mode. The step
// order is fixed by docs/on-host-spec.md and every refusal happens before the
// deploy lock is taken.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { log: defaultLog } = require('../log');
const { FULL_SHA_RE } = require('../sha-options');
const { RUN_ID_RE } = require('./outcome');

const INVOCATION_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const OPTION_ALLOWLIST = ['skipBuild', 'skipDeps', 'skipMigrate', 'verifyPins'];

class OnHostError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'OnHostError';
    this.code = code;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Every regular file under `dir`, as paths relative to `base`. A symlink or
// other special file is returned too, so the caller's manifest check rejects it.
function listFiles(dir, base) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(full, base));
    else found.push(path.relative(base, full));
  }
  return found;
}

function parseManifest(text) {
  const entries = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new OnHostError('ONHOST_MANIFEST', `unparseable manifest line ${JSON.stringify(line)}`);
    const rel = path.normalize(match[2]);
    if (path.isAbsolute(rel) || rel.startsWith('..')) {
      throw new OnHostError('ONHOST_MANIFEST', `manifest path ${JSON.stringify(match[2])} escapes the run dir`);
    }
    entries.set(rel, match[1]);
  }
  return entries;
}

// `sha256sum -c` equivalent, plus: nothing under kit/ may be absent from the manifest.
function verifyManifest(runDir) {
  const entries = parseManifest(fs.readFileSync(path.join(runDir, 'manifest.sha256'), 'utf8'));
  for (const required of ['config.json', 'meta.json']) {
    if (!entries.has(required)) throw new OnHostError('ONHOST_MANIFEST', `${required} is not in the manifest`);
  }
  for (const [rel, expected] of entries) {
    const full = path.join(runDir, rel);
    const stat = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) throw new OnHostError('ONHOST_MANIFEST', `${rel} is missing or not a regular file`);
    if (sha256File(full) !== expected) throw new OnHostError('ONHOST_MANIFEST', `${rel} does not match its manifest digest`);
  }
  const kitDir = path.join(runDir, 'kit');
  for (const rel of listFiles(kitDir, runDir)) {
    if (!entries.has(rel)) throw new OnHostError('ONHOST_MANIFEST', `${rel} is under kit/ but not in the manifest`);
  }
}

function readJson(runDir, name, code) {
  try {
    return JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
  } catch (error) {
    throw new OnHostError(code, `${name} is not valid JSON (${error.message})`);
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateMeta(meta, runId) {
  const bad = (why) => new OnHostError('ONHOST_META', why);
  if (!isObject(meta)) throw bad('meta.json is not an object');
  if (meta.runId !== runId) throw bad(`meta.runId ${JSON.stringify(meta.runId)} is not the run dir name ${runId}`);
  if (typeof meta.sha !== 'string' || !FULL_SHA_RE.test(meta.sha)) throw bad('meta.sha must be 40 lowercase hex characters');
  if (!isObject(meta.options)) throw bad('meta.options must be an object');
  for (const key of OPTION_ALLOWLIST) {
    if (key in meta.options && typeof meta.options[key] !== 'boolean') throw bad(`meta.options.${key} must be a boolean`);
  }
  for (const key of ['operatorVersion', 'operatorConfigSha256', 'operatorGitHead', 'createdAt']) {
    if (typeof meta[key] !== 'string' || meta[key] === '') throw bad(`meta.${key} must be a non-empty string`);
  }
  if (!SHA256_RE.test(meta.operatorConfigSha256)) throw bad('meta.operatorConfigSha256 must be 64 lowercase hex characters');
  const cap = meta.capture;
  if (!isObject(cap)) throw bad('meta.capture must be an object');
  if (!Number.isInteger(cap.oomScoreAdj)) throw bad('meta.capture.oomScoreAdj must be an integer');
  for (const key of ['path', 'umask', 'shell']) {
    if (typeof cap[key] !== 'string') throw bad(`meta.capture.${key} must be a string`);
  }
  if (!isObject(cap.env)) throw bad('meta.capture.env must be an object');
}

function validateConfig(config) {
  const bad = (why) => new OnHostError('ONHOST_CONFIG', why);
  if (!isObject(config)) throw bad('config.json is not an object');
  if (config.mode !== 'local') throw bad('config.mode must be "local"');
  if ('host' in config) throw bad('config.host must be absent');
  if (!config.layout || config.layout.type !== 'releases') throw bad('config.layout.type must be "releases"');
  if (config.lock === false) throw bad('config.lock must not be false');
  if (!Number.isFinite(config.stepTimeoutSeconds) || config.stepTimeoutSeconds <= 0) {
    throw bad('config.stepTimeoutSeconds must be a finite number > 0');
  }
  if (typeof config.localShell !== 'string' || !path.isAbsolute(config.localShell)) {
    throw bad('config.localShell must be an absolute path');
  }
}

function assertRunDir(runDir, uid) {
  const stat = fs.lstatSync(runDir, { throwIfNoEntry: false });
  const bad = (why) => new OnHostError('ONHOST_RUNDIR', `${runDir} ${why}`);
  if (!stat) throw bad('does not exist');
  if (stat.isSymbolicLink()) throw bad('is a symlink');
  if (!stat.isDirectory()) throw bad('is not a directory');
  if (stat.uid !== uid) throw bad(`is owned by uid ${stat.uid}, not ${uid}`);
  if ((stat.mode & 0o777) !== 0o700) throw bad(`has mode ${(stat.mode & 0o777).toString(8)}, not 700`);
}

function claimRun(runDir, invocationId) {
  let fd;
  try {
    fd = fs.openSync(path.join(runDir, 'started'), fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new OnHostError('ONHOST_REPLAY', 'this run dir was already started; refusing to replay (existing records untouched)');
    }
    throw error;
  }
  try {
    fs.writeSync(fd, invocationId);
  } finally {
    fs.closeSync(fd);
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function assertOomParity(meta, readOomScoreAdj) {
  let current;
  try {
    current = Number(String(readOomScoreAdj()).trim());
  } catch (error) {
    throw new OnHostError('ONHOST_OOM_SCORE', `cannot read /proc/self/oom_score_adj (${error.message})`);
  }
  if (!Number.isInteger(current)) throw new OnHostError('ONHOST_OOM_SCORE', 'oom_score_adj is not an integer');
  if (current > meta.capture.oomScoreAdj) {
    throw new OnHostError(
      'ONHOST_OOM_SCORE',
      `unit oom_score_adj ${current} is higher than the ssh session's ${meta.capture.oomScoreAdj}, so the kernel would kill this deploy `
      + `before the processes it manages. Set OOMScoreAdjust=${meta.capture.oomScoreAdj} in a user@.service drop-in and `
      + `DefaultOOMScoreAdjust=${meta.capture.oomScoreAdj} in /etc/systemd/user.conf.d/ (see the README's on-host section).`,
    );
  }
}

// Warn (never fail) when the PM2 daemon is not the system-managed service, so
// it would die with this unit's cgroup if the unit ever used KillMode=control-group.
function warnIfPm2NotSystemService({ env, log, readFile, run }) {
  try {
    const pm2Home = env.PM2_HOME || path.join(env.HOME || os.homedir(), '.pm2');
    const daemonPid = readFile(path.join(pm2Home, 'pm2.pid')).trim();
    const mainPid = String(run('systemctl', ['show', '-p', 'MainPID', '--value', `pm2-${env.USER}.service`])).trim();
    if (daemonPid === mainPid) return;
    log.warning(`PM2_DAEMON_NOT_SYSTEM_SERVICE: pm2.pid is ${daemonPid}, pm2-${env.USER}.service MainPID is ${mainPid}`);
  } catch (error) {
    log.warning(`PM2_DAEMON_NOT_SYSTEM_SERVICE: could not confirm the PM2 daemon is system-managed (${error.message})`);
  }
}

// deps are the test seams; production uses the defaults.
function hostRun(runDir, deps = {}) {
  const {
    deployRelease = (...args) => require('../release').deployRelease(...args),
    env = process.env,
    uid = process.getuid(),
    log = defaultLog,
    readOomScoreAdj = () => fs.readFileSync('/proc/self/oom_score_adj', 'utf8'),
    readFile = (file) => fs.readFileSync(file, 'utf8'),
    run = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 10000 }),
    now = () => new Date(),
  } = deps;

  let deployed = false;
  try {
    assertRunDir(runDir, uid);                                          // 1
    if (!INVOCATION_ID_RE.test(env.INVOCATION_ID || '')) {              // 2
      throw new OnHostError('ONHOST_INVOCATION_ID', 'INVOCATION_ID must be 32 lowercase hex characters (run under systemd)');
    }
    claimRun(runDir, env.INVOCATION_ID);                                // 3
    verifyManifest(runDir);                                             // 4
    const runId = path.basename(runDir);
    if (!RUN_ID_RE.test(runId)) throw new OnHostError('ONHOST_META', `run dir name ${runId} is not a run id`);
    const meta = readJson(runDir, 'meta.json', 'ONHOST_META');          // 5
    validateMeta(meta, runId);
    const config = readJson(runDir, 'config.json', 'ONHOST_CONFIG');
    validateConfig(config);
    assertOomParity(meta, readOomScoreAdj);                             // 6

    const allowlisted = {};
    for (const key of OPTION_ALLOWLIST) if (key in meta.options) allowlisted[key] = meta.options[key];
    const options = { ...allowlisted, sha: meta.sha, autoCut: false, stealLock: false };  // enforced values last
    let ok = true;
    let failure;
    try {
      deployed = true;
      deployRelease(config, options);                                   // 7
    } catch (error) {
      ok = false;
      failure = error instanceof Error ? error.message : String(error);
      log.error(failure);
    }
    const outcome = { runId, ok, ...(failure === undefined ? {} : { error: failure }), finishedAt: now().toISOString() };
    writeJsonAtomic(path.join(runDir, 'outcome.json'), outcome);        // 8
    if (ok) warnIfPm2NotSystemService({ env, log, readFile, run });     // 9
    return ok ? 0 : 1;
  } catch (error) {
    if (deployed) throw error; // the deploy ran; do not dress a bookkeeping failure as a refusal
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

module.exports = {
  hostRun, OnHostError, OPTION_ALLOWLIST, INVOCATION_ID_RE, listFiles, sha256File,
};

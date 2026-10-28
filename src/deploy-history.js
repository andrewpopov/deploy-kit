'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// PKG-274: per-run timing telemetry for `deploy` / `rollback`, recorded at the CLI boundary only.
// Best-effort: nothing here may throw, and nothing here changes a deploy's outcome.
const MAX_MARKS = 200;
const SAFE_TEXT = /^[a-z0-9:_.-]{1,80}$/i;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

const safeText = (value) => (typeof value === 'string' && SAFE_TEXT.test(value) ? value : 'other');

function serviceId(config) {
  const projectDir = String((config && config.projectDir) || '');
  const host = String((config && config.host) || '');
  const base = safeText(path.basename(projectDir).replace(/[^a-z0-9:_.-]/gi, '-').slice(0, 80) || 'other');
  const digest = crypto.createHash('sha256').update(`${host}:${projectDir}`).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

// Throws an Error whose message is a constant reason; the caller never prints anything else.
function appendLine(home, line) {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const dir = path.join(home, '.cache', 'deploy-kit');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch { throw new Error('history directory unavailable'); }
  let dirStat;
  try { dirStat = fs.lstatSync(dir); } catch { throw new Error('history directory unavailable'); }
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (uid !== null && dirStat.uid !== uid) || (dirStat.mode & 0o022) !== 0) {
    throw new Error('history directory unsafe');
  }
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
  let fd;
  try { fd = fs.openSync(path.join(dir, 'history.jsonl'), flags, 0o600); } catch { throw new Error('history file unavailable'); }
  try {
    const fileStat = fs.fstatSync(fd);
    if (!fileStat.isFile() || (uid !== null && fileStat.uid !== uid) || (fileStat.mode & 0o777) !== 0o600) {
      throw new Error('history file unsafe');
    }
    const bytes = Buffer.from(line, 'utf8');
    if (fs.writeSync(fd, bytes) !== bytes.length) throw new Error('history write incomplete');
  } finally {
    try { fs.closeSync(fd); } catch { /* nothing to recover */ }
  }
}

function createDeployRecorder({ operation, config, now = Date.now, clock = () => performance.now(), home = os.homedir() }) {
  const startedWall = now();
  const startedClock = clock();
  const marks = [];
  let finished = false;

  const onStep = (event) => {
    try {
      if (marks.length >= MAX_MARKS) return;
      const atMs = Math.max(0, Math.round(clock() - startedClock));
      marks.push({ step: safeText(event && event.step), class: safeText(event && event.class), atMs });
    } catch { /* telemetry must never disturb the deploy */ }
  };

  const finish = ({ result, sha }) => {
    if (finished) return;
    finished = true;
    try {
      const record = {
        version: 1,
        operation: safeText(operation),
        service: serviceId(config),
        sha: typeof sha === 'string' && SHA_PATTERN.test(sha) ? sha : null,
        result: result === 'ok' ? 'ok' : 'failed',
        startedAt: new Date(startedWall).toISOString(),
        endedAt: new Date(now()).toISOString(),
        durationMs: Math.max(0, Math.round(clock() - startedClock)),
        marks,
      };
      appendLine(home, `${JSON.stringify(record)}\n`);
    } catch (error) {
      const reason = error instanceof Error && /^history /.test(error.message) ? error.message : 'history write failed';
      console.warn(`deploy-kit: deploy history not recorded (${reason})`);
    }
  };

  return { onStep, finish };
}

module.exports = { createDeployRecorder };

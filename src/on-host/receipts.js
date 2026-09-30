'use strict';

// The operator-side record of `deploy --on-host` runs (PKG-187): one JSON line per
// run in ~/.deploy-kit/on-host-runs.jsonl. It is written BEFORE anything is
// submitted, so `attach <run-id>` can always find a run whose submission
// acknowledgement was lost. Shared by operator.js (write) and attach.js (read).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { RUN_ID_RE } = require('./outcome');

const SAFE_ABS_PATH_RE = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_UNIT_RE = /^[A-Za-z0-9_.-]+$/;

const defaultReceiptsPath = () => path.join(os.homedir(), '.deploy-kit', 'on-host-runs.jsonl');

function appendReceipt(receipt, receiptsPath = defaultReceiptsPath()) {
  fs.mkdirSync(path.dirname(receiptsPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

// Every field that later reaches an ssh command is shape-checked again on read,
// so an edited receipts file cannot smuggle an ssh option or a path elsewhere.
function isUsableReceipt(entry) {
  return entry !== null && typeof entry === 'object'
    && typeof entry.runId === 'string' && RUN_ID_RE.test(entry.runId)
    && typeof entry.host === 'string' && /^[^\s-]\S*$/.test(entry.host)
    && typeof entry.unit === 'string' && SAFE_UNIT_RE.test(entry.unit)
    && typeof entry.runDir === 'string' && SAFE_ABS_PATH_RE.test(entry.runDir);
}

// The LAST usable receipt for runId, or null.
function findReceipt(runId, receiptsPath = defaultReceiptsPath()) {
  let text;
  try {
    text = fs.readFileSync(receiptsPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let found = null;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry && entry.runId === runId && isUsableReceipt(entry)) found = entry;
  }
  return found;
}

module.exports = { defaultReceiptsPath, appendReceipt, findReceipt, SAFE_ABS_PATH_RE, SAFE_UNIT_RE };

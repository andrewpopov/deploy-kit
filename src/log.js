'use strict';

// Colored terminal logging — byte-compatible with the log_* / log.* helpers
// that were copy-pasted across bewks/kira/smarthome deploy scripts (BWK-86).

const { redact, DEFAULT_WEBHOOK_ENV: ALERT_WEBHOOK_ENV } = require('./alert-discord');
const { DEFAULT_WEBHOOK_ENV: RELEASE_WEBHOOK_ENV } = require('./announce-discord');

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

const FAILURE_TAIL_LINES = 40;

// A captured hook's output is otherwise discarded, so a failure surfaced only as a fixed message
// (mizen, 2026-10-18: "Pre-migration database backup failed"). Print the tail of what it said before
// the caller throws. The Discord webhook URLs are redacted with alert-discord's redactor.
function logFailureOutput(label, res, log) {
  const webhooks = [ALERT_WEBHOOK_ENV, RELEASE_WEBHOOK_ENV].map((name) => process.env[name]);
  for (const [stream, text] of [['stderr', res.stderr], ['stdout', res.output]]) {
    const lines = String(text || '').split('\n').filter((line) => line.trim() !== '');
    if (!lines.length) continue;
    const shown = lines.slice(-FAILURE_TAIL_LINES);
    const omitted = lines.length - shown.length;
    log.error(`${label} ${stream}${omitted ? ` (last ${shown.length} of ${lines.length} lines)` : ''}:`);
    for (const line of shown) log.error(`  ${webhooks.reduce((text, webhook) => redact(text, webhook), line)}`);
  }
}

function makeLogger(out = console.log, err = console.error) {
  return {
    info: (msg) => out(`${colors.blue}ℹ${colors.reset} ${msg}`),
    success: (msg) => out(`${colors.green}✓${colors.reset} ${msg}`),
    warning: (msg) => out(`${colors.yellow}⚠${colors.reset} ${msg}`),
    error: (msg) => err(`${colors.red}✗${colors.reset} ${msg}`),
    step: (msg) => out(`${colors.cyan}▸${colors.reset} ${msg}`),
    header: (msg) => out(`\n${colors.bright}${colors.cyan}${msg}${colors.reset}\n`),
    divider: () => out(`${colors.cyan}${'='.repeat(60)}${colors.reset}`),
  };
}

module.exports = { colors, makeLogger, logFailureOutput, log: makeLogger() };

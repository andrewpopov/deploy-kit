'use strict';

// Colored terminal logging — byte-compatible with the log_* / log.* helpers
// that were copy-pasted across bewks/kira/smarthome deploy scripts (BWK-86).

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

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

module.exports = { colors, makeLogger, log: makeLogger() };

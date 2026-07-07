'use strict';

const config = require('./config');
const log = require('./log');
const exec = require('./exec');
const deployMod = require('./deploy');
const remote = require('./remote');
const tunnel = require('./tunnel');
const initMod = require('./init');

// Destructure into locals so module.exports uses shorthand keys — Node's
// cjs-module-lexer only detects named exports for identifier/shorthand forms,
// so `key: mod.fn` would be invisible to ESM `import { fn }` consumers.
const {
  CONFIG_FILENAME, DEFAULT_CONFIG, REMOVED_KEYS, mergeConfig, validateConfig, loadConfig,
} = config;
const { colors, makeLogger } = log;
const {
  normalizeRuntime, buildTargetCommand, sshHardeningArgs, runOnTarget, buildHealthCommand,
} = exec;
const { deploy, rollback, resolveBranch, waitForHealth } = deployMod;
const { startTunnel } = tunnel;
const { init } = initMod;

module.exports = {
  // config
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  REMOVED_KEYS,
  mergeConfig,
  validateConfig,
  loadConfig,
  // logging
  colors,
  makeLogger,
  // exec seam
  normalizeRuntime,
  buildTargetCommand,
  sshHardeningArgs,
  runOnTarget,
  buildHealthCommand,
  // pipeline
  deploy,
  rollback,
  resolveBranch,
  waitForHealth,
  // remote ops
  remote,
  // tunnel
  startTunnel,
  // scaffold
  init,
};

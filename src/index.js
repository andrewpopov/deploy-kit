'use strict';

const config = require('./config');
const log = require('./log');
const exec = require('./exec');
const deployMod = require('./deploy');
const remote = require('./remote');
const tunnel = require('./tunnel');

// Destructure into locals so module.exports uses shorthand keys — Node's
// cjs-module-lexer only detects named exports for identifier/shorthand forms,
// so `key: mod.fn` would be invisible to ESM `import { fn }` consumers.
const { CONFIG_FILENAME, DEFAULT_CONFIG, mergeConfig, loadConfig } = config;
const { colors, makeLogger } = log;
const { normalizeRuntime, buildTargetCommand, runOnTarget, buildHealthCommand } = exec;
const { deploy, resolveBranch, waitForHealth } = deployMod;
const { startTunnel } = tunnel;

module.exports = {
  // config
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  mergeConfig,
  loadConfig,
  // logging
  colors,
  makeLogger,
  // exec seam
  normalizeRuntime,
  buildTargetCommand,
  runOnTarget,
  buildHealthCommand,
  // pipeline
  deploy,
  resolveBranch,
  waitForHealth,
  // remote ops
  remote,
  // tunnel
  startTunnel,
};

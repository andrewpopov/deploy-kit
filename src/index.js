'use strict';

const config = require('./config');
const log = require('./log');
const exec = require('./exec');
const deployMod = require('./deploy');
const remote = require('./remote');
const tunnel = require('./tunnel');
const initMod = require('./init');
const monitorMod = require('./monitor');
const portGuardMod = require('./port-guard');
const verifyPinsMod = require('./verify-pins');
const alertDiscordMod = require('./alert-discord');
const announceDiscordMod = require('./announce-discord');
const hostOperationsMod = require('./host-operations');
const autoCutMod = require('./auto-cut');

// Destructure into locals so module.exports uses shorthand keys — Node's
// cjs-module-lexer only detects named exports for identifier/shorthand forms,
// so `key: mod.fn` would be invisible to ESM `import { fn }` consumers.
const {
  CONFIG_FILENAME, DEFAULT_CONFIG, REMOVED_KEYS, mergeConfig, validateConfig, loadConfig,
} = config;
const { colors, makeLogger } = log;
const {
  normalizeRuntime, buildTargetCommand, sshHardeningArgs, runOnTarget, runScriptOnTarget, buildHealthCommand,
} = exec;
const { deploy, rollback, resolveBranch, waitForHealth } = deployMod;
const { startTunnel } = tunnel;
const { init } = initMod;
const { monitor } = monitorMod;
const { checkPortGuard } = portGuardMod;
const {
  parseGithubSpecifier, resolveInstalled, checkPin, verifyPins, formatReport: formatVerifyPinsReport,
} = verifyPinsMod;
const { formatDiscordMessage, alertDiscord, DEFAULT_WEBHOOK_ENV, DEFAULT_SERVICE, DISCORD_CONTENT_LIMIT, MAX_STDIN_BYTES } = alertDiscordMod;
const {
  formatDiscordMessage: formatReleaseDiscordMessage, announceDiscord, DEFAULT_WEBHOOK_ENV: DEFAULT_RELEASE_WEBHOOK_ENV,
} = announceDiscordMod;
const { DEPLOY_ACTION, runHostOperations, runCairnOperations } = hostOperationsMod;
const { autoCut, clearAutoCutPending, PENDING_RELEASE_PATH } = autoCutMod;

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
  runScriptOnTarget,
  buildHealthCommand,
  // pipeline
  deploy,
  rollback,
  resolveBranch,
  waitForHealth,
  // remote ops
  remote,
  // monitoring
  monitor,
  // tunnel
  startTunnel,
  // scaffold
  init,
  // port-guard CLI
  checkPortGuard,
  // verify-pins CLI (PKG-108) — assert a package.json github: pin matches what's
  // actually installed, catching npm's silent no-op on a bumped-tag-only pin.
  parseGithubSpecifier,
  resolveInstalled,
  checkPin,
  verifyPins,
  formatVerifyPinsReport,
  // alert-discord CLI (opt-in convenience alert.command; monitor stays policy-free)
  formatDiscordMessage,
  alertDiscord,
  DEFAULT_WEBHOOK_ENV,
  DEFAULT_SERVICE,
  DISCORD_CONTENT_LIMIT,
  MAX_STDIN_BYTES,
  // announce-discord CLI (opt-in convenience deliveryEvent.command; deploy/release stay policy-free)
  formatReleaseDiscordMessage,
  announceDiscord,
  DEFAULT_RELEASE_WEBHOOK_ENV,
  // host operation runner (generic)
  runHostOperations,
  // Cairn host operation runner (deprecated wrapper — see host-operations.js)
  DEPLOY_ACTION,
  runCairnOperations,
  // auto-cut (cut a release via PR before deploying — see auto-cut.js)
  autoCut,
  clearAutoCutPending,
  PENDING_RELEASE_PATH,
};

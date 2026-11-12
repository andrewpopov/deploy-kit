'use strict';

// PKG-318: the hooks, pre/post-deploy checks and monitor settings that run a deploy must come from
// the commit being shipped, not from the checkout deploy-kit happens to run in (a stale checkout once
// ran an old full-backup hook against a newer commit, and on a host deploy-kit runs inside the OLD
// checkout). A config read from `.deploy-kit.config.json` carries CONFIG_ORIGIN; deploy() and
// deployRelease() call these functions, so every entry point (CLI, programmatic, on-host) shares them.
//   resolveShipConfig:     the sha is known up front (--sha, or the requireVerifiedRef tip). The file is
//                          read from that commit in the controller checkout, fetching the exact sha.
//   resolveLateShipConfig: the sha only exists once the target has pulled or auto-cut has merged. The
//                          file is read from the target's own repository.
// The working-tree config is only the bootstrap: it chose the target and ref, so a sha whose bootstrap
// keys differ is refused instead of silently re-aimed.
const { execFileSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const { loadConfig, CONFIG_FILENAME, CONFIG_ORIGIN } = require('./config');
const { runLocal, wouldAutoCutRun } = require('./auto-cut');
const { shQuote } = require('./exec');
const { resolveVerifiedTip } = require('./verified-ref');
const { log: defaultLog } = require('./log');

const BOOTSTRAP_KEYS = ['mode', 'host', 'projectDir', 'ssh', 'remote', 'branch', 'requireVerifiedRef', 'autoCut', 'layout'];

// The sha could not be obtained (fetch failed, not a git checkout): a dry run may plan without it.
class ShaUnavailableError extends Error {}

const localGit = (cwd, command) => runLocal({ execFileSync }, cwd, command, { allowFailure: true });

function withoutOrigin(config) {
  const plain = { ...config };
  delete plain[CONFIG_ORIGIN];
  return plain;
}

// The controller's own remote names need not match the target's `config.remote`: try that name
// first, then every remote the checkout actually has.
function controllerRemotes(cwd, config) {
  const names = localGit(cwd, 'git remote').output.split('\n').map((n) => n.trim()).filter(Boolean);
  return [...new Set([...(names.includes(config.remote) ? [config.remote] : []), ...names])];
}

function controllerVerifiedTip(config, cwd) {
  const ref = `refs/heads/${config.requireVerifiedRef}`;
  const tipOf = () => {
    for (const remote of controllerRemotes(cwd, config)) {
      const found = localGit(cwd, `git ls-remote ${shQuote(remote)} ${shQuote(ref)}`);
      const tip = found.ok ? found.output.split(/\s/)[0] : '';
      if (tip) return { ok: true, output: tip };
    }
    return { ok: false, output: '' };
  };
  return resolveVerifiedTip(config, { fetch: () => ({ ok: true }), revParse: tipOf });
}

function ensureCommit(cwd, config, sha) {
  const has = () => localGit(cwd, `git cat-file -e ${shQuote(`${sha}^{commit}`)}`).ok;
  if (has()) return;
  const remotes = controllerRemotes(cwd, config);
  const failures = [];
  for (const remote of remotes) {
    const fetched = localGit(cwd, `git fetch ${shQuote(remote)} ${shQuote(sha)}`);
    if (fetched.ok && has()) return;
    failures.push(`${remote}: ${(fetched.stderr || 'fetch did not bring the commit in').trim().split('\n').pop()}`);
  }
  throw new ShaUnavailableError(
    `deploy: ${sha.slice(0, 8)} is not available in ${cwd} and could not be fetched (${failures.join('; ') || 'the checkout has no remotes'}). `
    + `Nothing was changed. Fetch the commit, then retry. (This is a fetch failure, not a missing ${CONFIG_FILENAME}.)`,
  );
}

function configPathInRepo(cwd) {
  const prefix = localGit(cwd, 'git rev-parse --show-prefix');
  return `${prefix.ok ? prefix.output.trim() : ''}${CONFIG_FILENAME}`;
}

function missingConfigError(sha, where) {
  return new Error(
    `deploy: ${sha.slice(0, 8)} has no ${CONFIG_FILENAME} ${where}, so there is no config to ship it with. `
    + 'Nothing was changed. Deploy a commit that contains the file.',
  );
}

function readConfigAtSha(cwd, sha) {
  if (!localGit(cwd, 'git rev-parse --git-dir').ok) {
    throw new ShaUnavailableError(`deploy: cannot read ${CONFIG_FILENAME} from ${sha.slice(0, 8)}: ${cwd} is not inside a git checkout`);
  }
  if (!localGit(cwd, `git cat-file -e ${shQuote(`${sha}^{commit}`)}`).ok) {
    throw new ShaUnavailableError(`deploy: ${sha.slice(0, 8)} is not present in ${cwd}, so its ${CONFIG_FILENAME} cannot be read`);
  }
  const shown = localGit(cwd, `git show ${shQuote(`${sha}:${configPathInRepo(cwd)}`)}`);
  if (!shown.ok) throw missingConfigError(sha, `in ${cwd}`);
  return shown.output;
}

function adoptShippedConfig(config, sha, configText, log) {
  const origin = config[CONFIG_ORIGIN];
  const shipped = loadConfig({ cwd: origin.cwd, override: origin.override, configText });
  for (const key of BOOTSTRAP_KEYS) {
    if (!isDeepStrictEqual(config[key], shipped[key])) {
      throw new Error(
        `deploy: "${key}" in the working tree's ${CONFIG_FILENAME} differs from the one in ${sha.slice(0, 8)} `
        + `(${JSON.stringify(config[key])} vs ${JSON.stringify(shipped[key])}). The target and ref were chosen from the working-tree copy, `
        + 'so this deploy is refused. Update the checkout to the commit being shipped and retry.',
      );
    }
  }
  if (!isDeepStrictEqual(withoutOrigin(config), shipped)) {
    log.warning(`deploy-kit: using ${CONFIG_FILENAME} from ${sha.slice(0, 8)} (the working tree differs)`);
  }
  return { ...shipped, [CONFIG_ORIGIN]: { ...origin, shippedSha: sha } };
}

// Returns { config, options }: the sha's config and, for a verified-ref deploy, `options.sha` pinned to
// the tip it was read from. Unchanged when the config has no file origin, or when no sha is known yet
// (auto-cut cuts its own, a plain branch deploy pulls on the target: see resolveLateShipConfig). A dry
// run fetches nothing: an unavailable sha plans from the working tree (warned); a commit that is
// present and has no config still fails closed.
function resolveShipConfig({ config, options = {}, log = defaultLog }) {
  const origin = config[CONFIG_ORIGIN];
  if (!origin) return { config, options };
  let sha = options.sha;
  if (!sha && config.requireVerifiedRef && !options.dryRun && !wouldAutoCutRun(config, { ...options, projectRoot: origin.cwd })) {
    sha = controllerVerifiedTip(config, origin.cwd);
    log.info(`verified ref "${config.requireVerifiedRef}" is ${sha.slice(0, 12)}`);
  }
  if (!sha) return { config, options };
  const pinned = { ...options, sha };
  if (origin.shippedSha === sha) return { config, options: pinned };
  try {
    if (!options.dryRun) ensureCommit(origin.cwd, config, sha);
    return { config: adoptShippedConfig(config, sha, readConfigAtSha(origin.cwd, sha), log), options: pinned };
  } catch (error) {
    if (!options.dryRun || !(error instanceof ShaUnavailableError)) throw error;
    log.warning(`deploy-kit: planning with the working-tree ${CONFIG_FILENAME}: ${error.message}`);
    return { config: { ...config, [CONFIG_ORIGIN]: { ...origin, shippedSha: sha } }, options: pinned };
  }
}

// `readOnTarget(spec)` runs `git show <spec>` where the target repository lives and returns
// { ok, output }. A planning runtime cannot answer it, so the caller skips this in a dry run.
function resolveLateShipConfig({ config, sha, readOnTarget, log = defaultLog }) {
  const origin = config[CONFIG_ORIGIN];
  if (!origin || origin.shippedSha === sha) return config;
  const shown = readOnTarget(`${sha}:${configPathInRepo(origin.cwd)}`);
  if (!shown.ok) throw missingConfigError(sha, 'in the target repository');
  return adoptShippedConfig(config, sha, shown.output, log);
}

module.exports = {
  resolveShipConfig, resolveLateShipConfig, BOOTSTRAP_KEYS, ShaUnavailableError,
};

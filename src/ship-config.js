'use strict';

// PKG-318: the hooks, pre/post-deploy checks, protections and monitor settings that run a deploy must
// come from the commit being shipped, not from the checkout deploy-kit happens to run in (a stale
// checkout once ran an old full-backup hook against a newer commit, and on a host deploy-kit runs
// inside the OLD checkout). A config read from `.deploy-kit.config.json` carries CONFIG_ORIGIN.
// resolveShipConfig is the ONE resolution point: deploy(), deployRelease() and onHostDeploy call it
// first, before preflight, protections, derived defaults and checks. It settles the FINAL sha up front
// (--sha; else the requireVerifiedRef tip; else the branch tip, pinned as options.sha so the target
// deploys exactly that commit) and reads the file from it in the controller checkout. Auto-cut cannot
// know its sha yet: it ships the tip's config and assertConfigAtCut checks the cut left it untouched.
// The working-tree config only bootstraps: a sha whose bootstrap keys differ is refused.
const { execFileSync } = require('child_process');
const { isDeepStrictEqual } = require('util');
const { loadConfig, CONFIG_FILENAME, CONFIG_ORIGIN } = require('./config');
const { runLocal, wouldAutoCutRun } = require('./auto-cut');
const { shQuote } = require('./exec');
const { resolveVerifiedTip } = require('./verified-ref');
const { log: defaultLog } = require('./log');
const { FULL_SHA_RE } = require('./sha-options');

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

function controllerTip(config, cwd, ref) {
  for (const remote of controllerRemotes(cwd, config)) {
    const found = localGit(cwd, `git ls-remote ${shQuote(remote)} ${shQuote(ref)}`);
    const tip = found.ok ? found.output.split(/\s/)[0] : '';
    if (tip) return { ok: true, output: tip };
  }
  return { ok: false, output: '' };
}

function controllerVerifiedTip(config, cwd) {
  return resolveVerifiedTip(config, {
    fetch: () => ({ ok: true }),
    revParse: () => controllerTip(config, cwd, `refs/heads/${config.requireVerifiedRef}`),
  });
}

// The branch a plain deploy ships: config.branch, else the remote's default branch, else master.
function controllerBranchTip(config, cwd) {
  let branch = config.branch;
  for (const remote of branch ? [] : controllerRemotes(cwd, config)) {
    const head = localGit(cwd, `git ls-remote --symref ${shQuote(remote)} HEAD`);
    const match = head.ok && head.output.match(/^ref: refs\/heads\/(\S+)\s+HEAD/m);
    if (match) { branch = match[1]; break; }
  }
  branch = branch || 'master';
  const tip = controllerTip(config, cwd, `refs/heads/${branch}`);
  if (!FULL_SHA_RE.test(tip.output)) {
    throw new Error(`deploy: could not resolve branch "${branch}" on any remote of ${cwd}, so there is no commit to read ${CONFIG_FILENAME} from. Nothing was changed.`);
  }
  return { branch, sha: tip.output };
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
  return { ...shipped, [CONFIG_ORIGIN]: { ...origin, shippedSha: sha, configText } };
}

// Returns { config, options }: the sha's config and `options.sha` pinned to the commit it was read
// from. Unchanged when the config has no file origin. A dry run contacts no remote: it resolves no
// tip, and an unavailable --sha plans from the working tree (warned), but a commit that is present
// and has no config still fails closed.
function resolveShipConfig({ config, options = {}, log = defaultLog }) {
  const origin = config[CONFIG_ORIGIN];
  if (!origin || origin.notGit) return { config, options };
  // ONE project root for resolution, the verified-ref guard and auto-cut: where the file was loaded from.
  const base = { ...options, projectRoot: origin.cwd };
  if (!localGit(origin.cwd, 'git rev-parse --git-dir').ok) {
    if (!options.dryRun) {
      throw new Error(
        `deploy: ${origin.cwd} is not a git checkout, so there is no commit to ship ${CONFIG_FILENAME} from, and a real deploy `
        + 'would run an unversioned file against the target. Run deploy-kit from a checkout of the app. Nothing was changed.',
      );
    }
    log.warning(`deploy-kit: ${origin.cwd} is not a git checkout; planning with ${CONFIG_FILENAME} as is`);
    return { config: { ...config, [CONFIG_ORIGIN]: { ...origin, notGit: true } }, options: base };
  }
  let sha = options.sha;
  let shipped = base;
  if (!sha && !options.dryRun) {
    const autoCut = wouldAutoCutRun(config, base);
    if (config.requireVerifiedRef) {
      if (options.branch !== undefined) return { config, options: base };
      sha = controllerVerifiedTip(config, origin.cwd);
      shipped = { ...base, sha };
      log.info(`verified ref "${config.requireVerifiedRef}" is ${sha.slice(0, 12)}`);
    } else {
      const tip = controllerBranchTip(config, origin.cwd);
      sha = tip.sha;
      log.info(`branch "${tip.branch}" is ${sha.slice(0, 12)}`);
      shipped = { ...base, branchTipPin: sha };
      if (!autoCut) {
        shipped.sha = sha;
        delete shipped.branch;
      }
    }
  }
  if (!sha) return { config, options: base };
  if (origin.shippedSha === sha) return { config, options: shipped };
  try {
    if (!options.dryRun) ensureCommit(origin.cwd, config, sha);
    return { config: adoptShippedConfig(config, sha, readConfigAtSha(origin.cwd, sha), log), options: shipped };
  } catch (error) {
    if (!options.dryRun || !(error instanceof ShaUnavailableError)) throw error;
    log.warning(`deploy-kit: planning with the working-tree ${CONFIG_FILENAME}: ${error.message}`);
    return { config: { ...config, [CONFIG_ORIGIN]: { ...origin, shippedSha: sha } }, options: shipped };
  }
}

// After auto-cut produced `sha`: the cut may only touch release files, so the config adopted from the
// tip must be byte-identical in the cut commit. A refusal, never an adoption.
function assertConfigAtCut(config, sha) {
  const origin = config[CONFIG_ORIGIN];
  if (!origin || origin.configText === undefined) return;
  ensureCommit(origin.cwd, config, sha);
  if (readConfigAtSha(origin.cwd, sha) !== origin.configText) {
    throw new Error(`deploy: auto-cut's release ${sha.slice(0, 8)} changed ${CONFIG_FILENAME} from the branch tip it was read from (${origin.shippedSha.slice(0, 8)}); refusing to deploy with a config that was not the one in use.`);
  }
}

// A branch-tip deploy pins the tip it read the config from; the target must still see that same tip.
function assertPinnedTipHolds(options, sha, tip, label) {
  if (options.branchTipPin && sha === options.branchTipPin && tip !== sha) {
    throw new Error(
      `Deploy aborted: ${label} moved to ${tip.slice(0, 12)} after ${CONFIG_FILENAME} was read from ${sha.slice(0, 12)}. `
      + 'Nothing was changed. Retry to deploy the new tip with its own config.',
    );
  }
}

module.exports = {
  resolveShipConfig, assertConfigAtCut, assertPinnedTipHolds, BOOTSTRAP_KEYS, ShaUnavailableError,
};

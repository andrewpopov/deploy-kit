'use strict';

// PKG-318: the hooks, pre/post-deploy checks and monitor settings that run a
// deploy must come from the commit being shipped, not from whatever the
// operator's working tree happens to hold (a stale checkout once ran an old
// full-backup hook against a newer commit). The working-tree config is only the
// bootstrap: it names the target and the ref. Once the sha is known the config
// is re-loaded from that sha through the same loadConfig, and a disagreement on
// a bootstrap key is refused, because those keys already decided where and what.
const { isDeepStrictEqual } = require('util');
const { loadConfig, CONFIG_FILENAME } = require('./config');
const { runLocal, wouldAutoCutRun } = require('./auto-cut');
const { shQuote, normalizeRuntime } = require('./exec');
const { resolveVerifiedTip } = require('./verified-ref');
const { log: defaultLog } = require('./log');

const BOOTSTRAP_KEYS = ['mode', 'host', 'projectDir', 'ssh', 'remote', 'branch', 'requireVerifiedRef', 'autoCut', 'layout'];

function localVerifiedTip(config, cwd, runtime) {
  const ref = config.requireVerifiedRef;
  const tracking = `${config.remote}/${ref}`;
  const refspec = `+refs/heads/${ref}:refs/remotes/${tracking}`;
  return resolveVerifiedTip(config, {
    fetch: () => runLocal(runtime, cwd, `git fetch ${shQuote(config.remote)} ${shQuote(refspec)}`, { allowFailure: true }),
    revParse: () => runLocal(runtime, cwd, `git rev-parse --verify --quiet ${shQuote(`${tracking}^{commit}`)}`, { allowFailure: true }),
  });
}

function readConfigAtSha(config, sha, cwd, runtime, { fetchMissing }) {
  const git = (command) => runLocal(runtime, cwd, command, { allowFailure: true });
  if (fetchMissing && !git(`git cat-file -e ${shQuote(`${sha}^{commit}`)}`).ok) git(`git fetch ${shQuote(config.remote)}`);
  const prefix = git('git rev-parse --show-prefix');
  if (!prefix.ok) throw new Error(`deploy: cannot read ${CONFIG_FILENAME} from ${sha.slice(0, 8)}: ${cwd} is not inside a git checkout`);
  const spec = `${sha}:${prefix.output.trim()}${CONFIG_FILENAME}`;
  const shown = git(`git show ${shQuote(spec)}`);
  if (!shown.ok) {
    throw new Error(
      `deploy: ${sha.slice(0, 8)} has no ${CONFIG_FILENAME} (git show ${spec} failed), so there is no config to ship it with. `
      + 'Nothing was changed. Deploy a commit that contains the file.',
    );
  }
  return shown.output;
}

// Returns { config, options }: the sha's config and, for a verified-ref deploy,
// `options.sha` pinned to the tip the config was read from. Unchanged when no
// sha is knowable yet (auto-cut cuts its own, a plain branch deploy resolves on
// the target). A dry run opens nothing and fetches nothing: it plans from the
// sha's config when the sha is already local, else from the working tree (warned).
function resolveShipConfig({
  config, options = {}, override = {}, cwd, runtime, log = defaultLog,
}) {
  const rt = normalizeRuntime(runtime);
  let sha = options.sha;
  if (!sha && config.requireVerifiedRef && !options.dryRun && !wouldAutoCutRun(config, { ...options, projectRoot: cwd })) {
    sha = localVerifiedTip(config, cwd, rt);
    log.info(`verified ref "${config.requireVerifiedRef}" is ${sha.slice(0, 12)}`);
  }
  if (!sha) return { config, options };

  let configText;
  try {
    configText = readConfigAtSha(config, sha, cwd, rt, { fetchMissing: !options.dryRun });
  } catch (error) {
    if (!options.dryRun) throw error;
    log.warning(`deploy-kit: planning with the working-tree ${CONFIG_FILENAME}: ${error.message}`);
    return { config, options };
  }
  const shipped = loadConfig({ cwd, override, configText });
  for (const key of BOOTSTRAP_KEYS) {
    if (!isDeepStrictEqual(config[key], shipped[key])) {
      throw new Error(
        `deploy: "${key}" in the working tree's ${CONFIG_FILENAME} differs from the one in ${sha.slice(0, 8)} `
        + `(${JSON.stringify(config[key])} vs ${JSON.stringify(shipped[key])}). The target and ref were chosen from the working-tree copy, `
        + 'so this deploy is refused. Update the checkout to the commit being shipped and retry.',
      );
    }
  }
  if (!isDeepStrictEqual(config, shipped)) {
    log.warning(`deploy-kit: using ${CONFIG_FILENAME} from ${sha.slice(0, 8)} (the working tree differs)`);
  }
  return { config: shipped, options: { ...options, sha } };
}

module.exports = { resolveShipConfig, BOOTSTRAP_KEYS };

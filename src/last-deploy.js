'use strict';

const { runOnTarget, shQuote } = require('./exec');

const LAST_DEPLOY_FILE = '.deploy-kit-last-deploy.json';
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

// Shell command that writes `json` to `file` ATOMICALLY: a same-dir temp file
// then `mv -f` over the target, so an interruption never leaves a truncated
// file. The one atomic-write idiom for on-target state files (the release
// journal uses it too); `mode` is chmod'ed onto the temp file before the rename.
function atomicWriteCommand(file, json, { mode } = {}) {
  const tmp = `${file}.tmp.$$`;
  const chmod = mode ? ` && chmod ${mode} ${tmp}` : '';
  return `printf '%s' ${shQuote(json)} > ${tmp}${chmod} && mv -f ${tmp} ${file}`;
}

// Record the commit a FULLY successful deploy left running, for host monitoring
// (Grafana deploy annotations). Pure observability: a failed write is logged as a
// warning and never fails the deploy. Only these five fields are ever written.
function writeLastDeployRecord(config, { sha, layout, release = null }, ctx) {
  try {
    if (!FULL_SHA_RE.test(sha || '')) {
      ctx.log.warning('Last-deploy record not written: the deployed commit could not be resolved to a full sha.');
      return false;
    }
    const json = JSON.stringify({
      version: 1, sha, finishedAt: new Date().toISOString(), layout, release,
    });
    // No projectDir means steps run in the current directory (local mode), so the record goes there too.
    const file = config.projectDir ? `${config.projectDir}/${LAST_DEPLOY_FILE}` : LAST_DEPLOY_FILE;
    const res = runOnTarget(atomicWriteCommand(file, json, { mode: '640' }), config, { runtime: ctx.runtime });
    if (!res.ok) throw new Error('write command failed');
    return true;
  } catch (error) {
    ctx.log.warning(`Last-deploy record (${LAST_DEPLOY_FILE}) could not be written: ${error.message}. The deploy itself succeeded.`);
    return false;
  }
}

module.exports = { LAST_DEPLOY_FILE, atomicWriteCommand, writeLastDeployRecord };

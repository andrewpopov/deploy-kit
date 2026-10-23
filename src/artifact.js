'use strict';

// BRAIN-636 D8: the identity of the installed kit. There is ONE global deploy-kit; it is identified by its version
// plus the sha256 of the npm tarball it was installed from. scripts/install-artifact.sh installs that tarball and
// writes ARTIFACT.json {name, version, sha256, installedAt} into the installed package root. A kit that was not
// installed that way (a checkout, a plain `npm i`) has no such file and reports itself `unpinned`: the controller's
// `check` refuses an unpinned kit, and every request and terminal.json records exactly what ran.

const fs = require('fs');
const path = require('path');

const ARTIFACT_FILE = 'ARTIFACT.json';
const SHA256_RE = /^[0-9a-f]{64}$/;
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const readIfPresent = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const isText = (v) => typeof v === 'string' && v !== '';

function artifactProblem(record, installedVersion) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (![record.name, record.version, record.installedAt].every(isText)) return 'name, version and installedAt must be non-empty strings';
  if (!SHA256_RE.test(record.sha256)) return 'sha256 must be 64 lowercase hex characters';
  if (record.version !== installedVersion) return `version ${record.version} is not the installed package's ${installedVersion}`;
  return null;
}

// -> {name, version, sha256, installedAt, source:'pinned'} from ARTIFACT.json, or {version, sha256:null,
// source:'unpinned'} when there is none. A file that is unreadable, malformed, or for a different version than the
// package beside it throws: a wrong identity must never be quietly downgraded to "unpinned".
function readArtifact({ root = PACKAGE_ROOT } = {}) {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const raw = readIfPresent(path.join(root, ARTIFACT_FILE));
  if (raw === null) return { version, sha256: null, source: 'unpinned' };
  let record;
  try {
    record = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${ARTIFACT_FILE} in ${root} is not valid JSON (${error.message})`);
  }
  const problem = artifactProblem(record, version);
  if (problem) throw new Error(`${ARTIFACT_FILE} in ${root}: ${problem}`);
  return {
    name: record.name, version: record.version, sha256: record.sha256, installedAt: record.installedAt, source: 'pinned',
  };
}

module.exports = { readArtifact, ARTIFACT_FILE };

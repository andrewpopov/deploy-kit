'use strict';

// PKG-315: a fingerprint of everything the install reads is recorded inside node_modules only after a successful install,
// and cleared before one starts, so a failed or killed install can never leave a marker that later skips.
const { shQuote, runOnTarget } = require('./exec');

const MARKER = 'node_modules/.deploy-kit-install-fingerprint';
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;
const LOCKFILES = [
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.npmrc',
];
const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

const tracking = (config) => config.skipUnchangedInstall !== false;
const mayReuse = (options = {}) => options.forceInstall !== true;

function fingerprintCommand(config) {
  const files = [...LOCKFILES, ...(config.installFingerprintFiles || [])].join(' ');
  const managers = PACKAGE_MANAGERS.join(' ');
  return [
    "v=$(echo 'process.stdout.write(process.version)' | node) || exit 1;",
    '{',
    `for f in ${files}; do if [ -f "$f" ]; then printf '== %s\\n' "$f"; cat "$f"; fi; done;`,
    "printf '== node %s\\n' \"$v\"; uname -sm;",
    `for pm in ${managers}; do if command -v "$pm" >/dev/null 2>&1; then printf '== %s %s\\n' "$pm" "$("$pm" --version 2>/dev/null)"; fi; done;`,
    `printf '== install %s\\n' ${shQuote(config.hooks.install)};`,
    "} | { sha256sum 2>/dev/null || shasum -a 256; } | cut -d' ' -f1",
  ].join(' ');
}

const parseFingerprint = (output) => {
  const last = String(output || '').trim().split('\n').pop().trim();
  return FINGERPRINT_RE.test(last) ? last : null;
};

const recordedCommand = `[ -d node_modules ] && cat ${MARKER} 2>/dev/null || true`;
const clearCommand = `rm -f ${MARKER}`;
const recordCommand = (fingerprint) => `printf '%s\\n' ${shQuote(fingerprint)} > ${MARKER}`;

function probeFingerprint(config, capture) {
  return parseFingerprint(capture(fingerprintCommand(config)));
}

function installInPlace({ config, options, runtime, run, log, annotate }) {
  const capture = (command) => (runOnTarget(command, config, { runtime, capture: true }).output || '').trim();
  const fingerprint = tracking(config) ? probeFingerprint(config, capture) : null;
  const unchanged = fingerprint !== null && mayReuse(options) && parseFingerprint(capture(recordedCommand)) === fingerprint;
  if (unchanged) {
    annotate('unchanged');
    log.step(`Skipping install: lockfiles, node and install command unchanged since the last successful install (${fingerprint.slice(0, 12)})`);
    return true;
  }
  run('Clearing the install fingerprint', clearCommand);
  run('Installing dependencies', config.hooks.install);
  if (fingerprint !== null) run('Recording the install fingerprint', recordCommand(fingerprint), { tolerate: true });
  return false;
}

function installInRelease({ config, options, releaseDir, currentDir, installCommand, captureIn, runIn, log, annotate }) {
  const fingerprint = tracking(config) ? probeFingerprint(config, (command) => captureIn(releaseDir, command)) : null;
  const unchanged = fingerprint !== null && mayReuse(options) && currentDir !== null
    && parseFingerprint(captureIn(currentDir, recordedCommand)) === fingerprint;
  if (unchanged) {
    annotate('unchanged');
    log.step(`Skipping install: reusing node_modules from ${currentDir} (lockfiles, node and install command unchanged, ${fingerprint.slice(0, 12)})`);
    if (runIn(releaseDir, `cp -a --reflink=auto ${shQuote(`${currentDir}/node_modules`)} node_modules`, { tolerate: true }).ok) return true;
    log.warning(`Copying node_modules from ${currentDir} failed; installing instead`);
    runIn(releaseDir, 'rm -rf node_modules');
  }
  runIn(releaseDir, installCommand);
  if (fingerprint !== null) runIn(releaseDir, recordCommand(fingerprint), { tolerate: true });
  return false;
}

module.exports = {
  MARKER, LOCKFILES, fingerprintCommand, parseFingerprint, probeFingerprint, recordedCommand, clearCommand, recordCommand, installInPlace, installInRelease,
};

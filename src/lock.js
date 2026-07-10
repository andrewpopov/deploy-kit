'use strict';

const { runOnTarget } = require('./exec');

// Stable per-target id from the projectDir (falls back to appNames/host).
// Sanitized to a filesystem-safe token so two deploys of the same target
// contend for the same lock but different targets don't. Also keeps the
// interpolated /tmp paths below free of shell metacharacters.
function lockId(config) {
  const raw = config.projectDir || config.appNames.join('-') || config.host || 'default';
  return raw.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function lockDir(config, suffix) {
  return `/tmp/deploy-kit-${lockId(config)}${suffix ? `-${suffix}` : ''}.lock`;
}

// Where the pre-pull SHA is recorded for legacy `rollback`. Kept in /tmp (not the
// worktree) so it never shows as an untracked file or collides with a repo path.
function prevShaFile(config) {
  return `/tmp/deploy-kit-${lockId(config)}.prev-sha`;
}

// Take the target lock (atomic mkdir). Returns a release fn. --steal-lock forces
// past a stale lock; config.lock:false disables locking entirely.
function acquireLock(config, ctx, { steal = false, suffix } = {}) {
  const noop = () => {};
  if (config.lock === false) return noop;
  const dir = lockDir(config, suffix);
  if (steal) {
    runOnTarget(`mkdir -p ${dir}`, config, { runtime: ctx.runtime });
  } else {
    const got = runOnTarget(`mkdir ${dir} 2>/dev/null`, config, { runtime: ctx.runtime });
    if (!got.ok) {
      throw new Error(
        `Another deploy holds the lock (${dir}). Wait for it to finish, or pass --steal-lock.`,
      );
    }
  }
  return () => runOnTarget(`rmdir ${dir} 2>/dev/null || true`, config, { runtime: ctx.runtime });
}

module.exports = { lockId, lockDir, prevShaFile, acquireLock };

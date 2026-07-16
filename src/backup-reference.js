'use strict';

// Backup hooks historically print either a restorable path/id as their final
// line or a db-backup JSON result. Keep that parsing in one place so both deploy
// layouts apply the same validation and delivery-event redaction.
// Preferred contract: a top-level `backupId` in JSON stdout (db-backup >= 0.18.0);
// the legacy fallbacks (id, created.fullPath, created.fileName, last line) remain.
const NO_BACKUP_ID_WARNING = 'backup hook output contained no backupId; restore correlation will be unavailable — emit {"backupId": ...} (db-backup >= 0.18.0 does this)';

function backupIdFromOutput(output, { log } = {}) {
  const text = String(output || '').trim();
  if (!text) {
    log?.warning?.(NO_BACKUP_ID_WARNING);
    return null;
  }

  let candidate;
  try {
    const parsed = JSON.parse(text);
    candidate = parsed?.backupId
      || parsed?.id
      || parsed?.created?.fullPath
      || parsed?.created?.fileName;
  } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    candidate = lines.at(-1);
  }

  if (typeof candidate === 'string' && candidate) return candidate;
  // The hook ran and produced output, but nothing parseable as an id. Warn
  // loudly — a silently-null backup id loses restore correlation — but never
  // fail the deploy over it.
  log?.warning?.(NO_BACKUP_ID_WARNING);
  return null;
}

function isSafeBackupId(id) {
  return typeof id === 'string'
    && /^[A-Za-z0-9._/-]+$/.test(id)
    && !id.endsWith('/')
    && !id.split('/').includes('..')
    && id.split('/').filter(Boolean).at(-1) !== '.';
}

function backupReferenceFromId(id) {
  if (!isSafeBackupId(id)) return undefined;
  const leaf = id.split('/').filter(Boolean).at(-1);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : undefined;
}

module.exports = { NO_BACKUP_ID_WARNING, backupIdFromOutput, isSafeBackupId, backupReferenceFromId };

'use strict';

// Backup hooks historically print either a restorable path/id as their final
// line or a db-backup JSON result. Keep that parsing in one place so both deploy
// layouts apply the same validation and delivery-event redaction.
function backupIdFromOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;

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

  return typeof candidate === 'string' && candidate ? candidate : null;
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

module.exports = { backupIdFromOutput, isSafeBackupId, backupReferenceFromId };

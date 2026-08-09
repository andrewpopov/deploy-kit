---
kind: fixed
summary: Verify DB-bound apps are actually paused before the pre-migration backup/migrate window
---

The legacy (non-release-layout) `deploy` pipeline pauses `dbBoundApps` before the pre-migration backup, but the `pm2 stop` was tolerant of failure with no verification — a stop that silently failed still let the backup and migration run against a live writer, risking an inconsistent backup. The pause is now verified: `deploy` snapshots which `dbBoundApps` are online immediately before the stop attempt and asserts none of those are still online immediately after, aborting (and resuming any paused apps first, same as every other gate in this window) if one is. Apps that were already stopped, or never registered in pm2, are untouched by the check, and an unreadable/unparseable `pm2 jlist` is treated as unknown rather than a failure, so a pm2/jq quirk on one host can't brick a deploy. Release-layout deploys already verify their pause this way and are unaffected.

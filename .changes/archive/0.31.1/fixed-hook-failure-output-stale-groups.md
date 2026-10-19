---
kind: fixed
summary: a failed backup hook now prints its stderr, and deploy --on-host refuses when the user manager has stale groups
---

A captured hook that failed (the backup gate in both layouts, and the pending-migrations probe) used to leave only a fixed message such as "Pre-migration database backup failed". deploy-kit now prints the last 40 lines of its stderr and stdout to the deploy log first, with Discord webhook URLs redacted. The thrown message is unchanged. Separately, `deploy --on-host` now compares the user's groups (`id -G`) with those of the `systemd --user` manager, which keeps the groups it started with, and refuses before anything is stopped when one is missing (`ONHOST_STALE_GROUPS`), naming it and the fix `sudo systemctl restart user@<uid>.service`. If the manager's groups cannot be read the check warns and is skipped.

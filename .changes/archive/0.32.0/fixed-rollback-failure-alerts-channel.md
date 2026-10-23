---
kind: fixed
summary: a failed rollback now also posts to the fleet alert webhook, and the rollback outcomes name the real release and app state
---

A failed automatic rollback now also posts one message straight to the webhook in `DISCORD_ALERT_WEBHOOK` (when set in deploy-kit's environment) through the `alert-discord` sender, so it no longer depends on an app's own release-channel sink. A send failure only warns. A rollback target counts as running only when every app is online from that release, so candidate processes that stay online no longer pass. A restored target whose apps do not start gets `rollback-failed-not-started` and names the rollback target, not the candidate. The "check failed identically on both releases" note is now also recorded when the rollback verifies cleanly and the outcome stays `rolled-back`.

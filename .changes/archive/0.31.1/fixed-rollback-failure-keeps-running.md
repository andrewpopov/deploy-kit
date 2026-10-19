---
kind: fixed
summary: a rollback whose own verification fails now leaves the previous release running and alerts, instead of leaving the service stopped
---

When a release-layout post-deploy check failed and the automatic rollback's verification then failed too, the apps were left as they were after the writer stop with only a `post-deploy-rollback-failed` journal and no alert. The rollback target is now left running (started again if it is not online) with `recoveryOutcome: rollback-failed-running`, while a failed DB restore, pointer flip-back or writer stop keeps the apps stopped as `rollback-failed`. Both still block the next deploy. The failed check is re-run on the rollback target, and when it also fails the journal's `recoveryNote` and the delivery event's `note` say "check failed identically on both releases: likely the check or its environment, not the release". The `failed` delivery event gains `appsState` and `note`, deploy-kit logs an `ALERT:` line, and `announce-discord` renders a distinct failed-rollback message.

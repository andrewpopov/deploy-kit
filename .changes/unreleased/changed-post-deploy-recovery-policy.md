---
kind: changed
summary: Release-layout post-deploy checks now have explicit, journaled recovery policies and failure events
---

Every release-layout post-deploy check must choose `rollback`, `remain-active`,
or `manual`. Failed checks persist their pending and terminal recovery state,
emit a structured failed or degraded delivery event, and make migration-aware
rollback restore and verify the previous code and database state. Hard
interruptions and failed rollback gates remain fail-closed for operator recovery.

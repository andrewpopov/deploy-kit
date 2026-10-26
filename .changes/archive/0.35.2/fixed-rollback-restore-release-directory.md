---
kind: fixed
summary: Run database restore hooks from the known-good rollback release
---

Release recovery resolves relative restore-hook paths inside the validated rollback target instead of the deployment root, which can contain stale scripts from an older installation. The captured backup identifier and existing migration uncertainty and writer-stop safeguards remain intact.

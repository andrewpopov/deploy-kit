---
kind: fixed
summary: Honor custom restart hooks across release-layout deployment and recovery
---

Release-layout deploy, rollback and recovery now use the documented restart override. Failed custom activation remains unsuccessful even if an existing process is healthy. Blank commands are rejected; the default PM2 activation retains its existing behavior.

---
kind: fixed
summary: target-state hostLockDir probes the provisioned parent, not the transient lock
---

`target-state --json` `hostLockDir` now reports the permanent `hostLock.dir` (group, mode, whether this user can create entries there) and whether the permanent `<key>.lock.guard` exists, as `{path, group, mode, writable, guard: {exists}}`. It used to probe `<key>.lock`, which is absent when idle and 0700 while held.

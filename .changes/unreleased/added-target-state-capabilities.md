---
kind: added
summary: `target-state --json` now reports the capability facts the controller's deploy check needs
---

The report carries `linger` (`true`/`false`, or `null` with `lingerProblem` when loginctl cannot say), `hostLockDir` (`{path, group, mode, writable}` when `hostLock` is configured, `{path, problem}` when the directory is missing or unreadable, `null` otherwise), `preflight` (`{ok, problems}`, the on-host preflight's checks run as a read-only probe through the same parser) and `proofReadable` (`{cgroup, procSessions}`: whether this user can read its own `user@UID.service` cgroup tree and another process's `/proc/<pid>/stat` session field, the evidence `lock break` relies on). Each probe runs inside the single lock-free read script, and a missing tool is reported as a problem, never as a failure.

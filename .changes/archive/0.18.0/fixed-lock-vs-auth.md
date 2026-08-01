---
kind: fixed
summary: An ssh transport or auth failure is no longer reported as a held lock. Acquiring the lock always ends in a genuine `exit 0` or `exit 1`, so anything else means the script never ran; only a confirmed `exit 1` now reports contention. Previously a `Permission denied (publickey)` surfaced as "Another deploy holds the lock ... pass --steal-lock" — recommending an action that was both useless and destructive, and hiding the real cause long enough that one host sat 19 commits behind.
---

Describe the user-facing change in one short paragraph before releasing.

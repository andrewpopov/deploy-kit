---
kind: added
summary: Lock owner records, a permanent flock guard file, no automatic takeover for onHost.required apps, and `deploy-kit lock inspect --json`
---

Every lock acquisition now writes an `owner` JSON record (kind, uid, user, bootId, unit, invocationId, pid, pstart, sid, runId, nonce, purpose) inside the lock directory, under an exclusive flock on a permanent sibling `<lock>.guard` file that acquire and release both take. With `onHost.required: true` a held lock is never taken over by age or `--steal-lock`; the contender refuses with `refused lock-held` and the owner record. Apps that do not opt in keep age-based takeover. `deploy-kit lock inspect --json` prints the owner record and guard state without mutating anything.

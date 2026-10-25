---
kind: fixed
summary: On-host runs re-check notAfter immediately before acceptance
---

A `preDeployChecks` command (or any other wait) that outlived `notAfter` no longer lets the run be accepted: the deadline is checked again right before `accepted.json` is written, and a late run is refused `late` with a `refused.json` and no acceptance.

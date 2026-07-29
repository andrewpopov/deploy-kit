---
kind: fixed
summary: custom monitor checks now report WHY they failed — stderr is no longer discarded
---

A failing `monitor.checks` entry alerted as a bare `<id>: failed`, with no
indication of what went wrong. `runOnTarget` piped the command's stderr but read
only `error.stdout` when building the failure detail, so the diagnostic that a
well-behaved CLI writes to stderr was captured and then thrown away. Every custom
check in every consumer was affected: the alert named which check broke and
nothing about why, which is exactly the information an operator needs at 3am.
`runOnTarget` now returns a separate `stderr` field (populated on the failure
path), and `checkCustom` composes its detail from stderr first, then stdout — so a
noisy stdout can no longer crowd the real reason out of the 300-character budget.
`output` remains pure stdout, so existing parsers (`pm2 jlist` JSON, `df` numbers)
are unaffected. TypeScript consumers of `runOnTarget` gain `stderr: string` on the
return type.

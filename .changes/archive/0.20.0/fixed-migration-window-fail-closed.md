---
kind: fixed
summary: Fail closed on unreadable pm2 state during the DB-bound app pause, and resume only what was actually paused
---

The legacy pipeline's DB-bound app pause (the guard around the pre-migration
backup) used to treat an unreadable `pm2 jlist` as "skip verification and
proceed" — meaning a pm2/ssh hiccup right before the migration window could
send a deploy into backup+migrate without ever confirming writers were
actually stopped. It now retries a bounded number of times and, if the state
is still unknown, fails closed: aborts before pausing anything if this happens
before the pause, or resumes and aborts if it happens after. Recovery
(`resumeDbApps`) also now resumes only the apps it actually observed running
before the pause — an app that was already stopped (e.g. for maintenance)
stays stopped through a failed-and-recovered deploy — and verifies the resume
actually took, surfacing a failed recovery loudly without masking the original
failure. The `pm2 jlist` probe carries its own short 30s bound rather than
inheriting `stepTimeoutSeconds`, so the new retry loop cannot hold the deploy
lock for the better part of an hour (or hang indefinitely on a consumer that
sets `stepTimeoutSeconds: null`). The app restart now runs as a gated step too:
it happens while the DB-bound apps are still paused, and a failed restart
previously aborted without attempting to bring them back at all.

The three separate `pm2 jlist` readers in deploy.js/release.js/checks.js are
consolidated onto one shared module (`pm2-state.js`) so this policy lives in
one place. That consolidation also closes two latent fail-open gaps: release.js
read empty `pm2 jlist` output as "zero processes running" (so an unreadable
list right after its stop attempt could report writers confirmed stopped), and
the monitor's `checks.js` reported empty output as "all down" rather than
UNKNOWN.

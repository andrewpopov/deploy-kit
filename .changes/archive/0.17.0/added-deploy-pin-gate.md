---
kind: added
summary: Deploys now abort when the target's installed packages disagree with what package.json pins
---

Neither `npm install` nor `npm ci` re-resolves a `github:owner/repo#<ref>` dependency when only the ref changes — verified against npm 11.9.0: with a lockfile at the v0.19.0 commit and a manifest asserting `#v0.20.0`, both commands exit 0 and leave 0.19.0 on disk. The whole install fallback chain is therefore silent about it, and a deploy reports success while shipping code the manifest says was replaced.

A `verify-pins` step now runs on the target immediately after install — before backup, migrate, build, and restart — and aborts the deploy on a mismatch, so the cost is a failed deploy rather than an outage or a security fix that never lands. It runs under `--skip-deps` too, since skipping the install makes a stale tree more likely, not less.

The checker is shipped to the target on stdin (the verbatim `verify-pins.js` source plus a runner, `fs`/`path` only) rather than invoked there, so it works on hosts whose installed deploy-kit predates the feature and needs no dependency on the target. Opt out with `verifyPins: false` or `--skip-pin-check`.

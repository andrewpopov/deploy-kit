---
kind: fixed
summary: artifact identity is verified against the installed tarball bytes
---

`scripts/install-artifact.sh` keeps the installed tarball as `ARTIFACT.tgz` beside `ARTIFACT.json`. `readArtifact()` and `deploy-kit artifact --json` recompute its sha256 and report `verified: true` only when it equals `ARTIFACT.json`'s; a missing tarball or a hash mismatch gives `verified: false` with a `problem`. An unpinned kit is unchanged.

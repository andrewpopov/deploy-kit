---
kind: fixed
summary: The declared release-kit pin now matches the one actually installed
---

`package.json` pinned `release-kit#v0.2.0` while `package-lock.json` resolved to the v0.3.1 commit — a committed disagreement, not stale local state, so `npm ci` installed v0.3.1 while the manifest claimed v0.2.0 and an `npm install` from the manifest could have downgraded it. PKG-98 installed the new version here but never saved the manifest, which is the same class of silent drift the deploy-time pin gate now catches.

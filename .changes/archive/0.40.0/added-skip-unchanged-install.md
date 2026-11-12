---
kind: added
summary: deploy skips the install step when the lockfiles, node version and install command are unchanged (PKG-315)
---

After a successful install deploy-kit records a fingerprint (lockfiles, `.npmrc`, `installFingerprintFiles`, `node --version`, the package manager versions, `uname -sm` and the install command) in `node_modules`. A deploy whose fingerprint matches skips `hooks.install`; the releases layout copies the current release's `node_modules` into the candidate (reflink where the filesystem supports it) instead of installing. `verify-pins` still runs. The timing table shows `install  0.0s (unchanged)`. Opt out with `skipUnchangedInstall: false` or force one install with `deploy --force-install`.

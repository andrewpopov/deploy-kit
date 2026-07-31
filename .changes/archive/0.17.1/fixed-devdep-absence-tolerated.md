---
kind: fixed
summary: A production install's absent devDependencies no longer abort the deploy
---

`verify-pins` graded a pinned devDependency with nothing installed as a fatal `missing`. But a production deploy target is installed with `npm ci --omit=dev`, so its devDependencies are *correctly* absent — meaning the new deploy pin gate would abort a perfectly healthy deploy. Caught by running the checker against the real hosts before the gate reached them: levelup reported `1 missing` for `@andrewpopov/eslint-config`, a devDependency that should not be on a production host at all.

devDependency absence now reports as the tolerated `absent` status, alongside optional and peer pins. Tolerance covers absence only — a devDependency installed at the *wrong* version still fails as `mismatch`, and an absent plain `dependencies` pin still fails as `missing`.

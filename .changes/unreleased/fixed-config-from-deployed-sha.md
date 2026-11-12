---
kind: fixed
summary: deploy loads .deploy-kit.config.json from the commit being shipped, not the checkout it runs in (PKG-318)
---

A stale checkout (or, for a deploy-kit run on the host, the host's old checkout) used to supply the hooks, checks and monitor settings for a newer commit. `deploy()`, `deployRelease()` and `deploy --on-host` now re-read a file-loaded config from the shipped sha through the same loader and validation, with the notice `deploy-kit: using .deploy-kit.config.json from <sha8> (the working tree differs)`. With `--sha` or a `requireVerifiedRef` tip it is read from the controller checkout (exact-sha fetch from any remote it has); for a branch-tip or auto-cut deploy it is read from the target's repository once the sha exists, before install. A commit without the file, an unfetchable sha, or a sha whose `mode`, `host`, `projectDir`, `ssh`, `remote`, `branch`, `requireVerifiedRef`, `autoCut` or `layout` differs from the working tree is refused. `--dry-run` fails closed on a local commit with no config. Configs built in code are used as given.

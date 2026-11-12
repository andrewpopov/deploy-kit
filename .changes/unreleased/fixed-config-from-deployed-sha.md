---
kind: fixed
summary: deploy now loads .deploy-kit.config.json from the commit being shipped, not the working tree (PKG-318)
---

A stale working tree used to supply the hooks, pre/post-deploy checks and monitor settings for a deploy of a newer commit (for example an old `hooks.backup`). Once the sha is known (`--sha`, or the `requireVerifiedRef` tip, which is now resolved up front and pinned as `--sha`), the config is re-read from that sha with `git show` through the same loader and validation, with the notice `deploy-kit: using .deploy-kit.config.json from <sha8> (the working tree differs)`. A sha with no config file is refused, and so is a sha whose `mode`, `host`, `projectDir`, `ssh`, `remote`, `branch`, `requireVerifiedRef`, `autoCut` or `layout` differs from the working tree (those chose the target and ref before the sha existed). `--dry-run` plans from the sha's config when it is already local. A deploy with neither `--sha` nor `requireVerifiedRef` (auto-cut, plain branch) still uses the working tree.

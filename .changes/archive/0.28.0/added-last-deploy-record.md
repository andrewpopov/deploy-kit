---
kind: added
summary: "A fully successful deploy writes .deploy-kit-last-deploy.json for host monitoring"
---

After restart, health and every `postDeployChecks` entry pass, both the legacy
and release pipelines atomically write `<projectDir>/.deploy-kit-last-deploy.json`
(`version`, `sha`, `finishedAt`, `layout`, `release`). Failed, aborted and
rolled-back deploys leave the previous record untouched, and a failure to write
it only logs a warning. On by default; no config option.

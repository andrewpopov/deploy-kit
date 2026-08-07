---
kind: added
summary: Add deploy-kit monitor --local to run the monitor and its alert sink on the local machine without ssh
---

`deploy-kit monitor` now accepts a `--local` flag that forces `mode: 'local'` for that
run only, via the existing validated `loadConfig` override. This lets a consumer repo
keep committing an ssh-mode config for laptop-driven `deploy`/`rollback` while still
running its 24/7 `monitor` cron directly on the target box — every check and the alert
sink execute with `sh -c`, no ssh, and `host` still identifies the target in alerts.

---
kind: added
summary: "deploy --on-host runs a release-layout deploy on the host so it survives the operator session; new attach command"
---

`deploy-kit deploy --on-host --sha <commit> --no-auto-cut` stages a self-contained
bundle on the host and runs the same release-layout pipeline there as a transient
systemd user unit, so losing the operator's session mid-deploy no longer strands the
host. `deploy-kit attach <run-id>` follows (or re-reads) a run from the records the
host writes; exit codes are 0 succeeded, 1 failed, 70 outcome unknown, 75 transport
lost (never redeploy on 75). New optional config keys: `onHost.env` (host environment
names forwarded to the unit) and `localShell` (the shell `mode: 'local'` commands use).
Host prerequisites (linger, OOM-score parity drop-ins, `KillUserProcesses=no`) are in
the README's "On-host deploys" section.

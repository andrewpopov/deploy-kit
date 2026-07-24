---
kind: security
summary: Harden ssh transport defaults and eliminate branch/remote shell injection
---

`branch` and `remote` are now shell-quoted at the git call site and charset-validated at config load. Since `branch` defaults to whatever the target's `origin/HEAD` resolves to, an attacker who could influence that ref on the remote could previously get arbitrary shell execution on your deploy target; a config with a `branch`/`remote` outside the legal git-refname charset now fails fast at `loadConfig` instead. `ssh` invocations default to `StrictHostKeyChecking=accept-new` and `BatchMode=yes` (emitted after any `ssh.options` you set, so your overrides still win) — an unattended deploy against a new host no longer hangs on an interactive key prompt, and a MITM'd known host is now caught rather than silently trusted. Lock and rollback state moved off world-writable `/tmp` to `$HOME/.deploy-kit` (mode `700`); no consumer action needed, but anything that inspected `/tmp/deploy-kit-*` directly should look in `~/.deploy-kit` instead. `ssh.options` and `deliveryEvent` are now shape-validated at config load.

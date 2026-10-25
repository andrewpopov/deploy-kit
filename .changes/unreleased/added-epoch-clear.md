---
kind: added
summary: deploy-kit epoch clear --reason drops the epoch fence
---

An operator verb under the same locked session as `epoch set`. It removes `.last-epoch` only when the app has no in-flight or unresolved marker and its lock is free (exit 3 `refused epoch-clear ...` otherwise), archiving the old value and the reason to `$HOME/.deploy-kit/epoch-cleared/<ts>.json`.

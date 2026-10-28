---
kind: added
summary: deploy and rollback record their duration in a private local history file
---

Each real `deploy` and `rollback` appends one timing row (duration, result, per-step offsets) to `~/.cache/deploy-kit/history.jsonl`, written best-effort with private file modes; on-host runs are not recorded yet.

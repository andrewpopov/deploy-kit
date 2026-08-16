---
kind: fixed
summary: Release-layout dry-run now prints a complete deterministic plan without contacting the target
---

The planner supplies consistent symbolic capture values for preflight, repository,
backup, PM2, activation, and pruning state, allowing every release phase to render
in order and exit successfully. No local target command or SSH probe executes;
configuration validation still fails by the exact invalid field before planning.

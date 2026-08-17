---
kind: added
summary: Add a validated deploy --branch NAME override
---

Operators can now deploy a non-default branch for one invocation without
editing `.deploy-kit.config.json`. The value passes through the same strict git
ref validation as `branch` in configuration and is rejected on commands other
than `deploy`.

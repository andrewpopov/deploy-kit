---
kind: added
summary: target-state reports physicalLayout from the host
---

`target-state --json` adds `physicalLayout` (`releases`, `legacy` or `unknown`), read from the host's `.deploy-kit-layout` marker and git checkout whichever config was supplied. `layout` still echoes the config.

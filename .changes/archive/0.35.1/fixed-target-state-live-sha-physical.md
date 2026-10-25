---
kind: fixed
summary: target-state reads the live sha by the host's physical layout, not the supplied config
---

`target-state --json` used to read the live sha through `current` whenever the supplied config said releases, so an unmigrated host (and a reversed one) had no readable sha. It now follows `physicalLayout`: `releases` reads the `current` release, `legacy` reads `git rev-parse HEAD` in `projectDir`, and `unknown` gives a null `liveSha` with a `liveProblem`.

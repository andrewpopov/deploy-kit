---
kind: fixed
summary: `--dry-run` can now preflight a release-layout host. The dry-run runtime returned an empty string for every command, so the `.deploy-kit-layout` marker read came back empty and preflight aborted with "requires a migrated host" against hosts whose marker existed and was readable — failing on exactly the layout the check protects. Genuinely read-only preflight probes now execute for real; anything that mutates, or depends on this run's own simulated mutations, stays simulated.
---

Describe the user-facing change in one short paragraph before releasing.

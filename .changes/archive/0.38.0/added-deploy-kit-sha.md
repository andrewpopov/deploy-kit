---
kind: added
summary: Pre-deploy checks see the sha that ships as DEPLOY_KIT_SHA (PKG-299)
---

A legacy-layout deploy now decides its sha before the pre-deploy checks whenever auto-cut will not run: `--sha`, or the `requireVerifiedRef` tip. Each `preDeployChecks` command runs as `export DEPLOY_KIT_SHA=<sha> && <command>`, so a check can judge the exact commit about to ship (TowerPower's review gate does). The deploy reuses that resolved tip instead of resolving the verified ref again, so a ref that moves mid-deploy cannot ship a commit the checks never saw. When auto-cut can run, or for a plain branch-tip deploy, the sha is only known later and `DEPLOY_KIT_SHA` is not set. The release layout is unchanged.

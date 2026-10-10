---
kind: changed
summary: A failed auto-cut push now says nothing was released or deployed, and what state the checkout is in
---

When the release-cut push is rejected (usually the repository's pre-push gate), or another step fails between the cut branch and the merge, the error now states that nothing was released or deployed, whether the controller checkout and local cut branch were restored, and what to do next. A dropped SSH connection is named as such. The release layout also logs that the live release is untouched and safe to re-run after a failure in preflight, materialize, install, build or validate.

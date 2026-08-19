---
kind: added
summary: Add a `clear-pending-release` CLI verb to discard a stuck auto-cut pending-release pointer.
---

auto-cut writes `.deploy-kit/pending-release.json` after merging a release PR
and, on the next run, resumes deploying that exact SHA instead of cutting
again — correct when a crash happens between merge and deploy, since the
release is already published.

It was wrong the night cairn hit it: auto-cut merged 1.1.1, the deploy then
failed its health gate on an unrelated latent bug, and the fix had to ship as
a new commit. The pointer kept pinning every subsequent deploy to 1.1.1, a
release that could not pass health, and the only way out was deleting the
file by hand — a deploy command with no documented escape.

`deploy-kit clear-pending-release [--dir PATH] [--json]` is that escape,
made explicit. It prints the version/sha/PR/timestamp it is about to discard,
removes the file, and says plainly that this does not unpublish, revert, or
un-merge the release it named — that release stays merged and released; only
the *next deploy's resume behavior* changes, falling back to deploying
current HEAD and cutting any pending fragments. It is idempotent (no pending
pointer is a plain success), and — like `verify-pins` — it is dispatched
before `.deploy-kit.config.json` is loaded, so it works even when the deploy
config or target is broken, which is exactly the situation an operator
reaching for it is in.

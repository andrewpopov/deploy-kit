---
kind: added
summary: requireVerifiedRef limits production deploys to commits the merge train's full suite verified
---

New config key `requireVerifiedRef` (default `null`, today's behaviour). Set to the train's `green` ref, a plain deploy ships that ref's tip instead of the branch tip, `--sha` must be contained in it (otherwise the deploy aborts naming the commit and the ref tip), and `--branch` is refused. A missing ref aborts before anything is touched. The legacy layout, the release layout and `deploy --on-host` share one helper; rollback is unchanged. It is a config error together with `autoCut`, with a malformed ref name, or equal to `branch`. There is no override flag.

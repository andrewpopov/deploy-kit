---
kind: fixed
summary: auto-cut issued an invalid git flag (--ignore-submodules=no) and aborted every deploy that had a pending release to cut.
---

`--ignore-submodules` takes `none`/`untracked`/`dirty`/`all`. `no` is not one of
them, so git rejected the clean-tree checks outright with `fatal: bad
--ignore-submodules argument: no` and the deploy aborted in preflight. It failed
closed — nothing on the target was touched — but any repo with unreleased
fragments could not deploy at all.

The whole 541-test suite passed with the broken flag, because every auto-cut
test drives a fake runtime that accepts whatever command string it is handed.
The bug surfaced on the first real deploy, in the first minute.

So `real-git-commands.test.ts` now takes the git command strings the source
actually issues and runs each against a real throwaway repo, asserting only
that git accepts the invocation. Reintroducing the bad flag fails it by name.
It also asserts the extractor found commands at all, so it cannot pass by
silently matching nothing.

---
kind: fixed
summary: auto-cut undercounted archived fragments when the archive directory was new, so any cut with more than one fragment aborted.
---

`git status --porcelain=v2` collapses a wholly-new directory into a single
untracked row, so a brand-new `archive/` reported one row no matter how many
fragments it held. The validator counted rows, concluded one fragment had been
archived, and aborted:

    expected 2 archived fragment copy(ies) under "docs/patch-notes/archive", observed 1

It now counts the fragment files actually on disk beneath a collapsed directory
row, resolved against the directory the cut ran in — which is the temp worktree
in local mode, not the process cwd. The assertion stays exact: a genuine
disagreement between archived and consumed fragments still fails.

Note the failure mode was inverted. The check was loosest with exactly one
fragment, which is the case every repo happened to be in, and only complained
once there were more — so it passed four real deploys by coincidence before
mizen's two fragments exposed it. The integration test now covers the
multi-fragment path, and reintroducing the undercount fails it with the same
message seen in production.

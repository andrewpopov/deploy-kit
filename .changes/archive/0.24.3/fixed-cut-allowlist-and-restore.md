---
kind: fixed
summary: auto-cut rejected its own correct output, mis-parsed untracked paths, and stranded the checkout on the cut branch when a cut failed.
---

Three defects, all found by running auto-cut against a real repo rather than a
fake one.

**The allowlist omitted the regenerated index.** `resolvePaths()` returns an
`indexPath` (`docs/PATCH_NOTES.md`), which every cut rewrites, but the expected
mutation set was built from the notes dir and manifests only. A perfectly
correct cut was rejected as touching "an unexpected path outside the allowlist".

**Untracked paths lost their first character.** `git status --porcelain=v2`
prefixes an untracked row with `? ` — two characters, not three. Slicing three
turned `.changes/archive/` into `changes/archive/`, so any newly created
directory failed to match the allowlist. Since git collapses a wholly-new
ancestor directory into one row, and every cut creates one, this broke every
real cut. A unit-test fixture had encoded the wrong prefix too, so the tests
agreed with the bug.

**A failed cut stranded the checkout.** After `git checkout -b release/cut-*`,
any later failure left the controller checkout on that branch with the cut's
changes in the tree. Preflight then refuses every subsequent deploy — clean tree
on the deploy branch — so one failure blocked all further attempts until someone
cleaned up by hand. The cut span is now wrapped so any failure discards the
cut's changes, returns to the deploy branch and deletes the temp branch. The
success path, which legitimately ends fast-forwarded to `R`, is untouched.

The durable fix is `auto-cut-integration.test.ts`: the real flow against a real
throwaway repo with a real git and a real release-kit, faking only `gh`. Every
bug above was invisible to the 550 unit tests, whose fake runtime accepts any
command and returns canned output. Reintroducing any of them fails the
integration test by name.

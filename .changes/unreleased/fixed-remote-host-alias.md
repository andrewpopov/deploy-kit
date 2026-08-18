---
kind: fixed
summary: auto-cut rejected SSH host aliases in remote URLs, so it aborted on the real remote of every repo in this fleet.
---

The owner/repo parser required a literal `github.com` host. Every repo here uses
an SSH host **alias** — `git@github-personal:andrewpopov/repo.git`, routed to
github.com by `~/.ssh/config` — which that pattern does not match, so auto-cut
aborted with "could not parse an owner/repo out of origin's push URL" on the
remote of every repo it was meant to serve.

The host is not what establishes repo identity: the `gh`-resolved slug is
compared against the remote's slug immediately afterwards, and that comparison
is the actual check. So the pattern now takes owner/repo from any host form —
scp-style, `ssh://`, `https://`, `git://` — and the identity assertion is
unchanged.

Like the `--ignore-submodules` bug before it, this was invisible to the test
suite, whose fake runtime returns a canned `github.com` URL. Both were found by
the first real deploy.

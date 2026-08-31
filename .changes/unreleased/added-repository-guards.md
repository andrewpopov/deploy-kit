---
kind: added
summary: Add configurable Cloudflare ingress and secret-filename repository guards
---

Applications can now run `deploy-kit verify-tunnel-config` and
`deploy-kit verify-no-secrets` from their local gate, with app-owned policy in
`deploy-kit.guards.json` and optional JSON output for automation.

`verify-tunnel-config` matches ingress hostnames the way cloudflared itself
does: an exact hostname matches only itself, and a `*.example.com` wildcard
matches any subdomain of `example.com` (never the apex). That matching is
shared by required-path lookup, catch-all shadow detection, and
`requiredHostnameRules`, so a wildcard rule is correctly treated as both a
potential shadower and a valid, documented way to satisfy an exact-host
requirement.

`requiredRules` also rejects an earlier hostname-applicable, non-catch-all
path regex that already matches a later required route's concrete path —
cloudflared stops at the first ingress rule that matches, so a broader
earlier pattern (e.g. `^/api(/.*)?$` ahead of `^/api/webhook$`) shadows the
more specific rule below it even though neither is a catch-all. This check
is deliberately conservative: it only fires when the required path is a
plain anchored literal that safely reduces to one concrete request path,
and the earlier rule's pattern compiles as valid regex — a malformed
earlier regex or a non-literal required path both back off without
guessing at regex equivalence.

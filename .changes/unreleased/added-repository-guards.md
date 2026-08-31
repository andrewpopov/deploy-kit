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

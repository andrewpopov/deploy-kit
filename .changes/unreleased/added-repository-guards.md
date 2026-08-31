---
kind: added
summary: Add configurable Cloudflare ingress and secret-filename repository guards
---

Applications can now run `deploy-kit verify-tunnel-config` and
`deploy-kit verify-no-secrets` from their local gate, with app-owned policy in
`deploy-kit.guards.json` and optional JSON output for automation.

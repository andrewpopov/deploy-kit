---
kind: added
summary: opt-in transition authority fences release-layout deploys and rollbacks and recovers durably from interrupted transitions
---

New `transitionAuthority: { command, scope, timeoutSeconds? }` config asks a trusted operator command to authorize each mutating release-layout v1 transition over a JSON stdin request and ACK, for local and SSH `deploy` and `rollback`. Progress is journaled in `.deploy-kit-transition-journal.json` and the protected, versioned `.deploy-kit-state.json`, so automatic, manual, interrupted and restart recovery stay fresh and parent-linked, and uncertain phase writes fail closed. Unconfigured deploys are unchanged. The host supplies lifetime exclusion, replay handling and signing; the package ships no production signer. See the README section Transition authority.

---
kind: fixed
summary: Automatically recover interrupted release deploys from the durable host journal
---

Release-layout deploys now restore a known-good running release from journaled
`stopped`, `migrated`, or `flipped` phases before beginning new work. Recovery
validates release pointers and backup identifiers, restores migrated databases,
and derives flip state from the live `current` pointer to cover atomic-flip
interruptions safely.

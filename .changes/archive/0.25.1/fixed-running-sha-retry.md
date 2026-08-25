---
kind: fixed
summary: Release-layout activation now retries the running-revision probe across transient startup races instead of rolling back a healthy deployment after one stale response.
---

The release-layout health gate already retried HTTP health, but sampled
`runningShaCommand` only once immediately afterward. An application could briefly
serve the previous revision while its scheduler and workers finished starting, so
deploy-kit rolled back a healthy release even though the expected revision became
visible moments later.

The revision probe now uses the same bounded attempts and delay policy as the
health gate. It still fails closed unless it observes the expected revision, and
an exhausted retry reports the final observed value and attempt count.

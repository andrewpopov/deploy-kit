---
kind: added
summary: "deploy: the legacy pipeline emits step marks, step lines carry elapsed seconds, and a deploy timing table prints with the downtime window"
---

A legacy `deploy()` now reports each step it runs through `ctx.onStep`, so history rows no longer carry `marks: []`.
Every `▸` step line ends in `[+12.3s]`, and `deploy()` prints a `deploy timing:` table (seconds per step, total,
downtime window) when a real deploy ends, successful or not. New built-in step names `auto-cut`, `stash`, `merge`,
`health` and `resume-writers`.

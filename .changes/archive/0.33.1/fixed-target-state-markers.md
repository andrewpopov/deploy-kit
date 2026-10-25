---
kind: fixed
summary: `target-state --json` now reports the app's unresolved and in-flight markers
---

The report carries `unresolved` and `inflight`, each `{present: true, requestId, runId, kind}` or `null` when the marker file is absent, so the controller can see an app that a deploy may have left changed or still running. A marker that exists but cannot be parsed or lacks `requestId`, `runId` or `kind` is reported as `{present: true, corrupt: true, requestId: null, runId: null, kind: null}`, never `null`, because an unreadable marker still blocks the app. The read stays lock-free and read-only.

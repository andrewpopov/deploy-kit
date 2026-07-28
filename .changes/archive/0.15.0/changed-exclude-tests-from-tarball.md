---
kind: changed
summary: Stop shipping src/__tests__ in the published package
---

`src/__tests__` is no longer included in the published tarball (30 files → 23). If you `require`/`import` anything from `src/__tests__` in a consumer, it will now be missing after `npm install`/`npm update` — nothing in the documented public API does this, so no action should be needed for a normal consumer.

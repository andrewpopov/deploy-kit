---
kind: added
summary: New `hooks.generate`, run by deploy-kit itself right after install and before build. A build served from an Nx/Turbo cache silently skips generation steps baked into the build script — the cache restores `dist/` but not artifacts written into `node_modules` — which put clipd into production crash-looping on "@prisma/client did not initialize yet". Because deploy-kit invokes this hook directly, no build tool's cache sits between it and the command, so a cache hit cannot skip it. Runs in the legacy pipeline, the release pipeline and legacy rollback.
---

Describe the user-facing change in one short paragraph before releasing.

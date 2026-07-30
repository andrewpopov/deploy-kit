---
kind: fixed
summary: "monitor: correct the stepCheck header comment and pin the copy to alert-kit with a conformance test"
---

The `stepCheck` header comment claimed `unknown` "clears the streaks". It never
did — the code preserves them (as the body comment three lines below always said),
which is what lets a flapping check still reach its alert threshold when an
indeterminate run lands between two failures. Documentation-only for behaviour, but
the comment is what a reader trusts when deciding whether a monitor will fire.

The canonical implementation now lives in `@andrewpopov/alert-kit`. deploy-kit keeps
its copy deliberately — this package declares zero runtime dependencies, and a
transitive `github:` resolve onto ARM Pi hosts with no CI is a worse failure than the
duplication — so alert-kit is a DEV dependency only, and a new conformance test drives
both implementations through an exhaustive transition matrix (~100k cases) so the copy
cannot drift silently. Nothing changes at runtime, and the published package still has
no dependencies.

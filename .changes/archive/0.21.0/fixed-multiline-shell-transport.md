---
kind: fixed
summary: Multiline target scripts have an stdin-safe execution path and JSON-encoded scripts fail closed
---

`runScriptOnTarget` sends a POSIX shell program over stdin instead of embedding
it in a controller-shell command. The lower-level target-command builder rejects
`JSON.stringify(script)` input before literal escaped newline tokens can become
commands, redirection targets, or deployment-root artifacts.

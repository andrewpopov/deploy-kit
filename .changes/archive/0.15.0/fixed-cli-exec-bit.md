---
kind: fixed
summary: The deploy-kit CLI is executable again, so `npm run deploy` works in consumers.
---

`src/cli.js` was committed as mode 100644, so a `github:` install linked `node_modules/.bin/deploy-kit` at a non-executable file and any invocation failed with `Permission denied`. The shebang was correct all along — it just never got to run. Consumers had to work around it by calling `node node_modules/@andrewpopov/deploy-kit/src/cli.js` directly.

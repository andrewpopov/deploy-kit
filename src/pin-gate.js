'use strict';

const fs = require('fs');
const path = require('path');

// The deploy-time pin gate. `npm install` does NOT re-resolve a
// `github:owner/repo#<ref>` dependency when only the ref changes, and — this is
// the part that makes it a deploy problem rather than a developer annoyance —
// neither does `npm ci`. Verified against npm 11.9.0: with a lockfile pinned to
// the v0.19.0 commit and a package.json asserting `#v0.20.0`, BOTH commands
// exit 0 and leave 0.19.0 on disk. npm's manifest/lock agreement check does not
// compare the `#ref` of a github: dependency, so the whole install fallback
// chain (`npm ci --prefer-offline || npm ci || npm install`) is silent about it.
//
// The consequence is a deploy that reports success while shipping code the
// manifest says was replaced. That is how a security fix marked DONE, released,
// and pinned still failed to reach a single running host.
//
// WHY THE CHECK RUNS ON THE TARGET: it compares what the deployed package.json
// asserts against what is actually in the target's node_modules, and only the
// target has both. It cannot invoke the target's own deploy-kit — every host in
// this fleet runs a copy that predates verify-pins (0.6.0-0.14.0 observed), and
// `node_modules/.bin` is not reliably populated there either. A gate that
// depends on already having been deployed cannot be the thing that fixes
// deployment.
//
// WHY THE PROGRAM IS BUILT FROM THE MODULE SOURCE: the program fed to the
// target's `node` is the VERBATIM text of verify-pins.js plus a small runner.
// One implementation, read off disk at call time — the remote path cannot drift
// from the local `deploy-kit verify-pins` command, because there is nothing to
// keep in sync. verify-pins.js requires only `fs` and `path`, so the target
// needs no dependency at all, which is what lets this work on a host whose
// installed deploy-kit is eight minor versions behind.
//
// The program is delivered on STDIN, never interpolated into the command line —
// see runOnTarget's `input` option, which exists for exactly this reason.

// Runs after the module source, in the same CJS scope, so `module.exports` is
// verify-pins.js's exports. Writes to stderr and sets the exit code; deploy.js
// turns a non-zero exit into an aborted deploy.
const RUNNER = `
;(() => {
  const { verifyPins, formatReport } = module.exports;
  const result = verifyPins({ dir: process.cwd() });
  const report = formatReport(result);
  for (const line of report.problemLines) console.error(line);
  for (const line of report.unverifiableLines) console.error(line);
  console.error(report.summaryLine);
  process.exit(result.ok ? 0 : 1);
})();
`;

// `node -` reads the program from stdin. No temp file to write, collide on, or
// clean up, and nothing lands on the target's disk.
const PIN_CHECK_COMMAND = 'node -';

function buildPinCheckProgram({ readFile = fs.readFileSync } = {}) {
  const source = readFile(path.join(__dirname, 'verify-pins.js'), 'utf8');
  return `${source}\n${RUNNER}`;
}

module.exports = { buildPinCheckProgram, PIN_CHECK_COMMAND };

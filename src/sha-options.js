'use strict';

// `--sha`'s format rule and its mutual exclusion with `--branch`, in ONE
// place. Before this (PKG-164 review finding 6), both lived only in cli.js's
// parse-time checks -- `deploy()`/`deployRelease()` are themselves exported,
// documented (index.d.ts), programmatic entry points, and calling either
// directly bypassed both rules entirely, silently deploying an abbreviated,
// uppercase, or non-hex "SHA" (or a `sha`+`branch` combination the CLI would
// have rejected). Called at the very top of deploy()/deployRelease(), before
// any target command, and by the CLI in place of its own regex/check, so
// there is exactly one rule each, not two copies that can drift.
const FULL_SHA_RE = /^[0-9a-f]{40}$/;

function assertShaOptions(options = {}) {
  if (options.sha !== undefined && !FULL_SHA_RE.test(options.sha)) {
    throw new Error(
      `Invalid --sha "${options.sha}": must be exactly 40 lowercase hex characters (a full, unabbreviated git `
      + 'commit SHA-1). Abbreviated, uppercase, or non-hex values are rejected -- ambiguity here is exactly '
      + 'what --sha exists to remove.',
    );
  }
  if (options.sha !== undefined && options.branch !== undefined) {
    throw new Error('deploy: --sha and --branch are mutually exclusive -- pass at most one');
  }
}

module.exports = { assertShaOptions, FULL_SHA_RE };

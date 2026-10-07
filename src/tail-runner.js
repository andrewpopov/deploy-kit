'use strict';

// Runs one command, streams its output live to this process's stderr, and reports
// the last `tailBytes` bytes of that output on stdout when it finishes. The exit
// status is the child's own. Used by exec.js's `tailBytes` option so a long-running
// hook (the restore) is neither buffered nor limited, yet a failure can say why.
//
// Diagnostics are strictly best-effort: a failure to keep, write or report the tail
// is swallowed and can never change the status or interrupt the child's output.

const { spawn } = require('child_process');
const os = require('os');

function createTailBuffer(limit) {
  let held = Buffer.alloc(0);
  return {
    push(chunk) {
      held = Buffer.concat([held, chunk]);
      if (held.length > limit) held = held.subarray(held.length - limit);
    },
    value: () => held,
  };
}

function statusOf(code, signal) {
  if (code !== null) return code;
  return 128 + (os.constants.signals[signal] || 0);
}

// Resolves to the child's exit status (a spawn failure is 127).
function runWithTail({
  file, args, tailBytes, makeTail = createTailBuffer, live = process.stderr, report = process.stdout,
}) {
  return new Promise((resolve) => {
    let tail = null;
    try { tail = makeTail(tailBytes); } catch { tail = null; }
    const child = spawn(file, args, { stdio: ['inherit', 'pipe', 'pipe'] });
    const onChunk = (chunk) => {
      try { live.write(chunk); } catch { /* the operator's terminal going away must not stall the child */ }
      if (tail) { try { tail.push(chunk); } catch { tail = null; } }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    // Forward the parent's timeout kill (SIGTERM) to the real command.
    const forward = () => child.kill('SIGKILL');
    process.once('SIGTERM', forward);
    const finish = (status) => {
      process.removeListener('SIGTERM', forward);
      let body = null;
      try { body = tail ? tail.value() : null; } catch { body = null; }
      if (!body || !body.length) { resolve(status); return; }
      try { report.write(body, () => resolve(status)); } catch { resolve(status); }
    };
    child.on('error', (error) => {
      try { live.write(`${error.message}\n`); } catch { /* best effort */ }
      finish(127);
    });
    child.on('close', (code, signal) => finish(statusOf(code, signal)));
  });
}

module.exports = { runWithTail, createTailBuffer };

if (require.main === module) {
  const [tailBytes, file, ...args] = process.argv.slice(2);
  runWithTail({ file, args, tailBytes: Number(tailBytes) }).then((status) => process.exit(status));
}

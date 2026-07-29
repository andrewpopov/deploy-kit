import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const { checkCustom } = require('../checks.js');
const { runOnTarget } = require('../exec.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

// A custom check that FAILS and writes its reason to stderr — the shape every
// well-behaved CLI uses, and the shape mizen's operational-check.mjs uses. The
// regression this file guards: deploy-kit captured stderr on the pipe but read
// only `error.stdout` when building the alert detail, so the reason was dropped
// and the operator got a bare "<id>: failed".
function failingRuntime({ stdout = '', stderr = '', code = 1 }) {
  return {
    execFileSync: () => {
      const error: any = new Error(`Command failed with exit code ${code}`);
      error.status = code;
      error.stdout = stdout;
      error.stderr = stderr;
      throw error;
    },
  };
}

const cfg = (checks: any[]) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  monitor: { checks, checkTimeoutSeconds: 30 },
});

const noopLog = { info() {}, success() {}, warning() {}, error() {}, step() {}, header() {}, divider() {} };

describe('runOnTarget stderr capture', () => {
  it('returns stderr on the failure path when capturing', () => {
    const res = runOnTarget('false', cfg([]), {
      capture: true,
      runtime: failingRuntime({ stdout: 'progress', stderr: 'the real reason' }),
    });
    expect(res.ok).toBe(false);
    expect(res.stderr).toBe('the real reason');
    // `output` stays PURE STDOUT so readPm2's JSON.parse and checkDisk's df
    // parsing are unaffected by this change.
    expect(res.output).toBe('progress');
  });

  it('reports an empty stderr on success rather than undefined', () => {
    const res = runOnTarget('true', cfg([]), {
      capture: true,
      runtime: { execFileSync: () => 'all good' },
    });
    expect(res.ok).toBe(true);
    expect(res.stderr).toBe('');
  });
});

describe('checkCustom failure detail', () => {
  it('surfaces a stderr-only reason in the alert message', () => {
    const results = checkCustom(cfg([{ id: 'worker-queues' }]), {
      runtime: failingRuntime({ stderr: 'object_deletion_queue oldest 17008s > 3600s' }),
      log: noopLog,
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('crit');
    expect(results[0].message).toContain('object_deletion_queue oldest 17008s > 3600s');
    // The bug's signature: the reason missing entirely, leaving a bare "failed".
    expect(results[0].message).not.toBe('worker-queues: failed');
  });

  it('puts stderr ahead of stdout so a noisy stdout cannot crowd out the reason', () => {
    const results = checkCustom(cfg([{ id: 'noisy' }]), {
      runtime: failingRuntime({ stdout: 'x'.repeat(400), stderr: 'THE REASON' }),
      log: noopLog,
    });
    expect(results[0].message).toContain('THE REASON');
    expect(results[0].message.indexOf('THE REASON')).toBeLessThan(results[0].message.indexOf('xxx'));
  });

  it('bounds the combined detail, filling the budget from stderr and excluding stdout', () => {
    const results = checkCustom(cfg([{ id: 'huge' }]), {
      runtime: failingRuntime({ stdout: 'b'.repeat(500), stderr: 'a'.repeat(500) }),
      log: noopLog,
    });
    const detail = results[0].message.replace('huge: failed — ', '');
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail).not.toMatch(/[^\x20-\x7e]/);
    // The assertions that actually pin the fix: the budget is filled from STDERR and
    // stdout is excluded entirely. Asserting only length+printability passed even with
    // the fix fully reverted (300 'b's of stdout is also 300 printable chars), which
    // made this a decoration rather than a guard.
    expect(detail).toMatch(/^a+\.\.\.$/);
    expect(detail).not.toContain('b');
  });

  it('marks a truncated detail with an ellipsis instead of a dangling separator', () => {
    // 297 stderr chars + ' | ' puts the 300-char cut inside the separator, which used
    // to emit an alert ending in a bare '|' -- indistinguishable from a command that
    // printed garbage.
    const results = checkCustom(cfg([{ id: 'edge' }]), {
      runtime: failingRuntime({ stderr: 's'.repeat(297), stdout: 'STDOUT' }),
      log: noopLog,
    });
    const detail = results[0].message.replace('edge: failed — ', '');
    expect(detail.length).toBeLessThanOrEqual(300);
    expect(detail.endsWith('...')).toBe(true);
    expect(detail).not.toMatch(/\|\s*$/);
  });

  it('leaves a detail that fits entirely unmarked', () => {
    const results = checkCustom(cfg([{ id: 'small' }]), {
      runtime: failingRuntime({ stderr: 'short reason' }),
      log: noopLog,
    });
    expect(results[0].message).toBe('small: failed — short reason');
  });

  it('honours the configured warn level', () => {
    const results = checkCustom(cfg([{ id: 'soft', level: 'warn' }]), {
      runtime: failingRuntime({ stderr: 'degraded' }),
      log: noopLog,
    });
    expect(results[0].status).toBe('warn');
    expect(results[0].message).toContain('degraded');
  });

  it('reports a timeout as unknown, not as a crit with detail', () => {
    const timeoutRuntime = {
      execFileSync: () => {
        const error: any = new Error('timed out');
        error.code = 'ETIMEDOUT';
        error.stderr = 'partial noise';
        throw error;
      },
    };
    const results = checkCustom(cfg([{ id: 'slow' }]), { runtime: timeoutRuntime, log: noopLog });
    expect(results[0].status).toBe('unknown');
    expect(results[0].message).toContain('timed out');
  });
});

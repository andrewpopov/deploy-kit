// PKG-135 Finding 2: `resources`, `gitInfo`, and `dashboard` used to run their
// underlying inspection commands, discard every result, and `return true`
// unconditionally — so their CLI commands (`deploy-kit resources`/`git`/
// `dashboard`) exited 0 even when the SSH connection failed and no inspection
// happened at all. These tests assert the honest, discriminating case: a
// failed underlying command must flip the return value to false, not just
// that a call "runs" and returns something truthy.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const remote = require('../remote.js') as {
  resources: (config: unknown, ctx?: unknown) => boolean;
  gitInfo: (config: unknown, ctx?: unknown) => boolean;
  dashboard: (config: unknown, ctx?: unknown) => boolean;
};
const { mergeConfig, DEFAULT_CONFIG } = kit;

const noopLog = {
  info() {}, success() {}, warning() {}, error() {}, step() {}, header() {}, divider() {},
};

const baseConfig = mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', mode: 'ssh', appNames: ['app'], port: 3000, healthPath: '/api/health',
});

// A fake execFileSync that fails any command whose rendered text matches one
// of `fail`'s substrings (a real target shell that rejects a command exits
// non-zero — same convention as deploy-kit.test.ts's makeRuntime), and
// otherwise succeeds with a canned response (200 for the health curl).
function makeRuntime({ fail = [] as string[] } = {}) {
  const calls: string[] = [];
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (fail.some((f) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      err.status = 1;
      throw err;
    }
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { runtime: { execFileSync }, calls, log: noopLog };
}

describe('remote.resources', () => {
  it('returns true when every underlying command succeeds', () => {
    const { runtime, calls, log } = makeRuntime();
    expect(remote.resources(baseConfig, { runtime, log })).toBe(true);
    expect(calls.some((c) => c.includes('free -h'))).toBe(true);
    expect(calls.some((c) => c.includes('df -h'))).toBe(true);
    expect(calls.some((c) => c.includes('uptime'))).toBe(true);
  });

  it('returns false when the target is unreachable (every command fails)', () => {
    const { runtime, log } = makeRuntime({ fail: ['free -h', 'df -h', 'uptime'] });
    expect(remote.resources(baseConfig, { runtime, log })).toBe(false);
  });

  it('returns false when only ONE underlying command fails, not just when all do', () => {
    const { runtime, log } = makeRuntime({ fail: ['uptime'] });
    expect(remote.resources(baseConfig, { runtime, log })).toBe(false);
  });
});

describe('remote.gitInfo', () => {
  it('returns true when every underlying command succeeds', () => {
    const { runtime, calls, log } = makeRuntime();
    expect(remote.gitInfo(baseConfig, { runtime, log })).toBe(true);
    expect(calls.some((c) => c.includes('rev-parse --abbrev-ref HEAD'))).toBe(true);
    expect(calls.some((c) => c.includes('git log -1'))).toBe(true);
    expect(calls.some((c) => c.includes('git status --short'))).toBe(true);
  });

  it('returns false when the SSH connection fails (every command fails)', () => {
    const { runtime, log } = makeRuntime({ fail: ['git'] });
    expect(remote.gitInfo(baseConfig, { runtime, log })).toBe(false);
  });

  it('returns false when only the trailing `git status` fails', () => {
    const { runtime, log } = makeRuntime({ fail: ['git status'] });
    expect(remote.gitInfo(baseConfig, { runtime, log })).toBe(false);
  });
});

describe('remote.dashboard', () => {
  it('returns true when status + health + gitInfo all succeed', () => {
    const { runtime, log } = makeRuntime();
    expect(remote.dashboard(baseConfig, { runtime, log })).toBe(true);
  });

  it('returns false when `pm2 status` fails (SSH down), even though it never throws', () => {
    const { runtime, log } = makeRuntime({ fail: ['pm2 status'] });
    expect(remote.dashboard(baseConfig, { runtime, log })).toBe(false);
  });

  it('returns false when the health probe is unreachable', () => {
    const { runtime, log } = makeRuntime({ fail: ['curl'] });
    expect(remote.dashboard(baseConfig, { runtime, log })).toBe(false);
  });

  it('returns false when the composed gitInfo call fails', () => {
    const { runtime, log } = makeRuntime({ fail: ['git log'] });
    expect(remote.dashboard(baseConfig, { runtime, log })).toBe(false);
  });

  it('still runs status, health, AND gitInfo even after an earlier one fails (full inspection, not short-circuited)', () => {
    const { runtime, calls, log } = makeRuntime({ fail: ['pm2 status'] });
    remote.dashboard(baseConfig, { runtime, log });
    expect(calls.some((c) => c.includes('curl'))).toBe(true);
    expect(calls.some((c) => c.includes('git log -1'))).toBe(true);
  });
});

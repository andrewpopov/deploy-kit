// BRAIN-636 review finding 9: an app that did not opt in (no onHost.required) must run exactly the lock
// scripts of v0.32.0 -- no guard prelude, no owner file. The old module is loaded from the git tag, like
// consumer-regression.test.ts does, so the expectation cannot drift from what that release emitted.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import Module from 'module';

const require = createRequire(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const kit = require('../index.js') as typeof import('../index');
const exec = require('../exec.js');
const currentLock = require('../lock.js');
const { mergeConfig, DEFAULT_CONFIG } = kit as any;

function loadLockAtTag(tag: string) {
  const source = execSync(`git show ${tag}:src/lock.js`, { cwd: REPO_ROOT, encoding: 'utf8' });
  const filename = path.join(REPO_ROOT, 'src', 'lock.js');
  const m = new Module(filename, module);
  m.filename = filename;
  (m as any).paths = (Module as any)._nodeModulePaths(path.dirname(filename));
  const nodeRequire = m.require.bind(m);
  (m as any).require = (id: string) => (id === './exec' ? exec : nodeRequire(id));
  (m as any)._compile(source, filename);
  return m.exports as typeof currentLock;
}
const oldLock = loadLockAtTag('v0.32.0');

// Every command the lock module sends to the target, with the stdio mode it asked for.
function record(lock: typeof currentLock, config: any, options: Record<string, unknown>) {
  const calls: { cmd: string; stdio: unknown }[] = [];
  const execFileSync = (_file: string, args: string[], opts: any) => {
    const cmd = args[args.length - 1];
    calls.push({ cmd, stdio: opts.stdio });
    return cmd.startsWith('cat ') ? 'n0nce-from-target\n' : '';
  };
  const release = lock.acquireLock(config, { runtime: { execFileSync } }, options);
  release();
  return calls;
}

const configs = {
  ssh: mergeConfig(DEFAULT_CONFIG, { mode: 'ssh', host: 'app@host', appNames: ['legacy-app'], projectDir: '/srv/legacy-app' }),
  local: mergeConfig(DEFAULT_CONFIG, { mode: 'local', appNames: ['legacy-app'], projectDir: '/srv/legacy-app' }),
};

describe('lock scripts for an app that did not opt in', () => {
  it.each(Object.entries(configs))('%s: acquire and release are byte-identical to v0.32.0', (_name, config) => {
    expect(record(currentLock, config, {})).toEqual(record(oldLock, config, {}));
  });

  it.each(Object.entries(configs))('%s: --steal-lock acquire is byte-identical to v0.32.0', (_name, config) => {
    expect(record(currentLock, config, { steal: true })).toEqual(record(oldLock, config, { steal: true }));
  });

  it('the monitor lock (suffix) is byte-identical to v0.32.0', () => {
    expect(record(currentLock, configs.ssh, { suffix: 'monitor' })).toEqual(record(oldLock, configs.ssh, { suffix: 'monitor' }));
  });

  it('carries no guard and writes no owner file', () => {
    const text = record(currentLock, configs.ssh, {}).map((c) => c.cmd).join('\n');
    expect(text).not.toMatch(/flock|\.guard|owner/);
  });

  it('an opted-in app still gets the guard and the owner record', () => {
    const optedIn = mergeConfig(configs.ssh, { onHost: { required: true } });
    const text = record(currentLock, optedIn, {}).map((c) => c.cmd).join('\n');
    expect(text).toMatch(/flock/);
    expect(text).toMatch(/owner/);
  });
});

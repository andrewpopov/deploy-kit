import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const lock = require('../lock.js') as typeof import('../lock');
const { mergeConfig, DEFAULT_CONFIG, validateConfig } = kit as any;

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

const homes: string[] = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-kit-hostlock-'));
  homes.push(dir);
  mkdirSync(join(dir, 'hosts'));
  return dir;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

function runtimeFor(home: string, commands: string[] = []) {
  const execFileSync = (file: string, args: string[], opts: any = {}) => {
    commands.push(args[args.length - 1]);
    return realExecFileSync(file, args, {
      ...opts, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  return { execFileSync };
}

const appConfig = (home: string, app: string, over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  mode: 'local',
  appNames: [app],
  autoCut: false,
  hostLock: { dir: join(home, 'hosts'), key: 'bigpi' },
  ...over,
});

const hostDir = (home: string) => join(home, 'hosts', 'bigpi.lock');

describeOnPosix('hostLock config', () => {
  const problems = (hostLock: unknown) => validateConfig({ hostLock }, { source: 'config' });

  it('accepts { dir, key } and rejects shapes that could break the shell or escape the dir', () => {
    expect(problems({ dir: '/var/lib/deploy-kit/hosts', key: 'bigpi' })).toEqual([]);
    expect(problems({ dir: 'relative', key: 'bigpi' }).join('\n')).toMatch(/hostLock.dir/);
    expect(problems({ dir: '/a/../b', key: 'bigpi' }).join('\n')).toMatch(/hostLock.dir/);
    expect(problems({ dir: '/a b', key: 'bigpi' }).join('\n')).toMatch(/hostLock.dir/);
    expect(problems({ dir: '/a', key: 'a/b' }).join('\n')).toMatch(/hostLock.key/);
    expect(problems({ dir: '/a', key: 'x', extra: 1 }).join('\n')).toMatch(/extra/);
  });
});

describeOnPosix('shared host lock', () => {
  it('B waits while A holds the host lock, and proceeds once A releases', () => {
    const home = freshHome();
    const a = lock.acquireOwnedLocks(appConfig(home, 'app-a'), { runtime: runtimeFor(home) }, { notAfter: 1000, runId: 'run-a' });
    expect(existsSync(hostDir(home))).toBe(true);

    let sleeps = 0;
    const b = lock.acquireOwnedLocks(appConfig(home, 'app-b'), { runtime: runtimeFor(home) }, {
      notAfter: 1000,
      runId: 'run-b',
      now: () => 10,
      sleep: () => { sleeps += 1; if (sleeps === 2) lock.releaseOwnedLocks(a); },
    });

    expect(sleeps).toBe(2);
    expect(b.released).toBe(false);
    expect(JSON.parse(readFileSync(join(hostDir(home), 'owner'), 'utf8')).runId).toBe('run-b');
    lock.releaseOwnedLocks(b);
    expect(existsSync(hostDir(home))).toBe(false);
  });

  it('refuses `late` when the host lock is still held at notAfter, taking nothing', () => {
    const home = freshHome();
    const a = lock.acquireOwnedLocks(appConfig(home, 'app-a'), { runtime: runtimeFor(home) }, { notAfter: 1000, runId: 'run-a' });
    let t = 0;
    const attempt = () => lock.acquireOwnedLocks(appConfig(home, 'app-b'), { runtime: runtimeFor(home) }, {
      notAfter: 3, runId: 'run-b', now: () => t, sleep: () => { t += 1; },
    });
    expect(attempt).toThrow(expect.objectContaining({ code: 'late' }));
    expect(t).toBe(3);
    expect(JSON.parse(readFileSync(join(hostDir(home), 'owner'), 'utf8')).runId).toBe('run-a');
    expect(existsSync(join(home, '.deploy-kit', 'deploy-kit-app-b.lock'))).toBe(false);
    lock.releaseOwnedLocks(a);
  });

  it('takes the host lock first and then the app lock, and releases in reverse', () => {
    const home = freshHome();
    const commands: string[] = [];
    const config = appConfig(home, 'app-a');
    const handle = lock.acquireOwnedLocks(config, { runtime: runtimeFor(home, commands) }, { notAfter: 1000, runId: 'run-a' });
    const makes = commands.filter((c) => c.includes('mkdir -m 700'));
    expect(makes).toHaveLength(2);
    expect(makes[0]).toContain(hostDir(home));
    expect(makes[1]).toContain('deploy-kit-app-a.lock');

    commands.length = 0;
    lock.releaseOwnedLocks(handle);
    const removes = commands.filter((c) => c.includes('rm -rf'));
    expect(removes).toHaveLength(2);
    expect(removes[0]).toContain('deploy-kit-app-a.lock');
    expect(removes[1]).toContain(hostDir(home));
    expect(handle.released).toBe(true);
  });

  it('releases the host lock if the app lock cannot be taken in time', () => {
    const home = freshHome();
    const first = lock.acquireLock(appConfig(home, 'app-a', { hostLock: null }), { runtime: runtimeFor(home) });
    expect(() => lock.acquireOwnedLocks(appConfig(home, 'app-a'), { runtime: runtimeFor(home) }, {
      notAfter: 1, now: () => 5, sleep: () => {},
    })).toThrow(expect.objectContaining({ code: 'late' }));
    expect(existsSync(hostDir(home))).toBe(false);
    first();
  });
});

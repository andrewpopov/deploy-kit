import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync, spawn, spawnSync } from 'child_process';
import {
  mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const lock = require('../lock.js') as typeof import('../lock');
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number };

// The lock is POSIX shell run through `sh -c` (mode:'local'); see lock.test.ts.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;
const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;
const describeWithFlock = process.platform === 'win32' || !hasFlock ? describe.skip : describe;

const { mergeConfig, DEFAULT_CONFIG } = kit;

function runtimeFor(home: string, extraEnv: Record<string, string> = {}) {
  const execFileSync = (file: string, args: string[], opts: any = {}) => realExecFileSync(file, args, {
    ...opts,
    env: { ...process.env, HOME: home, ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { execFileSync };
}

const lockConfig = (over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  mode: 'local',
  appNames: ['brain636-lockown'],
  autoCut: false,
  ...over,
});
const optedConfig = (over: any = {}) => lockConfig({ onHost: { required: true }, ...over });

const homes: string[] = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-kit-lockown-'));
  homes.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

const lockPath = (config: any, home: string) => lock.lockDir(config).replace('$HOME', home);
const readOwner = (config: any, home: string) => JSON.parse(readFileSync(join(lockPath(config, home), 'owner'), 'utf8'));
const age = (config: any, home: string) => writeFileSync(
  join(lockPath(config, home), 'ts'),
  String(Math.floor(Date.now() / 1000) - lock.lockTtlSeconds(config) - 60),
);

describeOnPosix('lock owner record', () => {
  it('writes every owner field at acquisition, null where it does not apply', () => {
    const home = freshHome();
    const config = lockConfig();
    lock.acquireLock(config, { runtime: runtimeFor(home) });

    const owner = readOwner(config, home);
    expect(Object.keys(owner).sort()).toEqual([
      'bootId', 'invocationId', 'kind', 'nonce', 'pid', 'pstart', 'purpose', 'runId', 'sid', 'uid', 'unit', 'user',
    ]);
    expect(owner.kind).toBe('legacy');
    expect(owner.uid).toBe(process.getuid?.());
    expect(owner.user).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(owner.pid).toBeGreaterThan(0);
    expect(owner.invocationId).toBeNull();
    expect(owner.unit).toBeNull();
    expect(owner.runId).toBeNull();
    expect(owner.purpose).toBeNull();
    expect(owner.nonce).toBe(readFileSync(join(lockPath(config, home), 'nonce'), 'utf8').trim());
    if (existsSync('/proc/self/stat')) {
      expect(owner.bootId).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      expect(owner.pstart).toBeGreaterThan(0);
      expect(owner.sid).toBeGreaterThan(0);
    }
  });

  it('records a systemd invocation as kind unit, and caller-supplied runId/purpose', () => {
    const home = freshHome();
    const config = lockConfig();
    lock.acquireLock(config, {
      runtime: runtimeFor(home, { INVOCATION_ID: 'abcdef0123456789abcdef0123456789' }),
    }, { runId: 'run-42', purpose: 'deploy' });

    const owner = readOwner(config, home);
    expect(owner.kind).toBe('unit');
    expect(owner.invocationId).toBe('abcdef0123456789abcdef0123456789');
    expect(owner.runId).toBe('run-42');
    expect(owner.purpose).toBe('deploy');
  });

  it('rejects an owner field that could break out of the record', () => {
    const config = lockConfig();
    expect(() => lock.acquireLock(config, { runtime: runtimeFor(freshHome()) }, { purpose: 'x"; rm -rf /' }))
      .toThrow(/purpose must match/);
  });
});

describeOnPosix('lock release', () => {
  it('removes the lock only when the nonce still matches', () => {
    const home = freshHome();
    const config = lockConfig();
    const runtime = runtimeFor(home);
    const release = lock.acquireLock(config, { runtime });
    writeFileSync(join(lockPath(config, home), 'nonce'), 'someone-elses-nonce\n');

    release();
    expect(existsSync(lockPath(config, home))).toBe(true);
    expect(readFileSync(join(lockPath(config, home), 'nonce'), 'utf8').trim()).toBe('someone-elses-nonce');
  });

  it('removes the lock when the nonce matches', () => {
    const home = freshHome();
    const config = lockConfig();
    lock.acquireLock(config, { runtime: runtimeFor(home) })();
    expect(existsSync(lockPath(config, home))).toBe(false);
  });
});

describeWithFlock('lock guard file', () => {
  it('is a permanent inode: same file across acquire, release and acquire', () => {
    const home = freshHome();
    const config = lockConfig();
    const runtime = runtimeFor(home);
    const guard = lock.guardFile(config).replace('$HOME', home);

    const release = lock.acquireLock(config, { runtime });
    const first = statSync(guard);
    expect(first.mode & 0o777).toBe(0o600);
    release();
    expect(existsSync(lockPath(config, home))).toBe(false);
    expect(existsSync(guard)).toBe(true);
    lock.acquireLock(config, { runtime });
    expect(statSync(guard).ino).toBe(first.ino);
  });

  it('serializes: an acquire waits for whoever holds the guard', () => {
    const home = freshHome();
    const config = lockConfig();
    const guard = lock.guardFile(config).replace('$HOME', home);
    lock.acquireLock(config, { runtime: runtimeFor(home) })(); // creates the guard
    // Hold the guard for ~1.5s from a separate process.
    const holder = spawn('sh', ['-c', `exec 9>> "${guard}"; flock -x 9; echo held; sleep 1.5`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => {
        try {
          const started = Date.now();
          lock.acquireLock(config, { runtime: runtimeFor(home) });
          expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  });

  it('two contenders racing: exactly one wins', async () => {
    const home = freshHome();
    const script = `
      const lock = require(${JSON.stringify(join(__dirname, '..', 'lock.js'))});
      const config = ${JSON.stringify(lockConfig())};
      try { lock.acquireLock(config, {}); console.log('WON'); } catch (e) { console.log('LOST'); }
    `;
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve) => {
      const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, HOME: home } });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out.trim().split('\n').pop() as string));
    })));
    expect(results.filter((r) => r === 'WON')).toHaveLength(1);
    expect(results.filter((r) => r === 'LOST')).toHaveLength(5);
  });
});

// The guarded path with onHost.required: true (flock present). The block above runs it for a
// plain config; the opted-in config is the one whose safety rests on the guard.
describeWithFlock('lock guard with onHost.required', () => {
  const holdGuard = (guard: string, seconds: number) => {
    const holder = spawn('sh', ['-c', `exec 9>> "${guard}"; flock -x 9; echo held; sleep ${seconds}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    return new Promise<void>((resolve) => { holder.stdout.once('data', () => resolve()); });
  };

  it('acquire, inspect and release all work and leave the permanent guard behind', () => {
    const home = freshHome();
    const config = optedConfig();
    const runtime = runtimeFor(home);
    const guard = lock.guardFile(config).replace('$HOME', home);

    const release = lock.acquireLock(config, { runtime });
    const inode = statSync(guard).ino;
    expect(lock.inspectLock(config, { runtime }).guard).toMatchObject({ present: true, held: false, inode });
    release();
    expect(existsSync(lockPath(config, home))).toBe(false);
    expect(statSync(guard).ino).toBe(inode);
  });

  it('a second acquirer blocks while the guard flock is held, then proceeds', async () => {
    const home = freshHome();
    const config = optedConfig();
    const guard = lock.guardFile(config).replace('$HOME', home);
    lock.acquireLock(config, { runtime: runtimeFor(home) })();
    await holdGuard(guard, 1.5);

    const started = Date.now();
    lock.acquireLock(config, { runtime: runtimeFor(home) });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(readOwner(config, home).nonce).toMatch(/^[0-9a-f]+$/);
  });

  it('a release blocks while the guard is held, so it cannot race a breaker', async () => {
    const home = freshHome();
    const config = optedConfig();
    const guard = lock.guardFile(config).replace('$HOME', home);
    const release = lock.acquireLock(config, { runtime: runtimeFor(home) });
    await holdGuard(guard, 1.5);

    const started = Date.now();
    release();
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(existsSync(lockPath(config, home))).toBe(false);
  });

  it('inspect reports the guard as held while another process holds it, without blocking', async () => {
    const home = freshHome();
    const config = optedConfig();
    const guard = lock.guardFile(config).replace('$HOME', home);
    lock.acquireLock(config, { runtime: runtimeFor(home) });
    await holdGuard(guard, 1.5);

    const started = Date.now();
    expect(lock.inspectLock(config, { runtime: runtimeFor(home) }).guard.held).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a contender is refused (not queued behind the guard) when the lock is held and the guard is free', () => {
    const home = freshHome();
    const config = optedConfig();
    lock.acquireLock(config, { runtime: runtimeFor(home) });
    expect(() => lock.acquireLock(config, { runtime: runtimeFor(home) })).toThrow(/refused lock-held/);
  });

  it('an opted-in app refuses (exit 2) on a host without flock; a plain app proceeds unguarded', () => {
    if (['/usr/bin/flock', '/bin/flock'].some((p) => existsSync(p))) return; // flock is on the default PATH here
    const home = freshHome();
    const noFlock = runtimeFor(home, { PATH: '/usr/bin:/bin' });
    expect(() => lock.acquireLock(optedConfig(), { runtime: noFlock })).toThrow(/Could not run the lock-check/);
    expect(existsSync(lockPath(optedConfig(), home))).toBe(false);
    lock.acquireLock(lockConfig({ appNames: ['brain636-plain'] }), { runtime: noFlock });
  });
});

describeOnPosix('lock takeover policy', () => {
  it('a non-opted app still takes over a lock older than the TTL (existing behaviour)', () => {
    const home = freshHome();
    const config = lockConfig();
    const runtime = runtimeFor(home);
    lock.acquireLock(config, { runtime });
    const before = readOwner(config, home).nonce;
    age(config, home);

    expect(() => lock.acquireLock(config, { runtime })).not.toThrow();
    expect(readOwner(config, home).nonce).not.toBe(before);
  });

  it('an onHost.required app is NOT taken over even when stale by age; the owner is reported', () => {
    const home = freshHome();
    const config = optedConfig();
    const runtime = runtimeFor(home);
    lock.acquireLock(config, { runtime });
    const before = readOwner(config, home);
    age(config, home);

    let message = '';
    try { lock.acquireLock(config, { runtime }); } catch (error) { message = (error as Error).message; }
    expect(message).toMatch(/refused lock-held/);
    expect(message).toContain(before.nonce);
    expect(readOwner(config, home)).toEqual(before);
  });

  it('an onHost.required app refuses --steal-lock', () => {
    const home = freshHome();
    const config = optedConfig();
    const runtime = runtimeFor(home);
    lock.acquireLock(config, { runtime });
    const before = readOwner(config, home);

    expect(() => lock.acquireLock(config, { runtime }, { steal: true })).toThrow(/--steal-lock is refused/);
    expect(readOwner(config, home)).toEqual(before);
  });

  it('rejects a non-boolean onHost.required at config time', () => {
    const { validateConfig } = require('../config.js') as { validateConfig: (raw: any) => string[] };
    const base = { host: 'a@b', appNames: ['a'] };
    expect(validateConfig({ ...base, onHost: { required: 'yes' } }).join('\n')).toMatch(/onHost\.required/);
    expect(validateConfig({ ...base, onHost: { required: true } }).join('\n')).not.toMatch(/onHost/);
  });
});

function snapshotTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      out[p] = `${st.isDirectory() ? 'd' : 'f'}:${st.mtimeMs}:${st.ino}:${st.isDirectory() ? '' : readFileSync(p, 'utf8')}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(root);
  return out;
}

describeOnPosix('lock inspect', () => {
  it('reports owner and guard state without mutating anything', () => {
    const home = freshHome();
    const config = optedConfig();
    const runtime = runtimeFor(home);
    lock.acquireLock(config, { runtime });
    const before = snapshotTree(home);

    const report = lock.inspectLock(config, { runtime });
    expect(report.held).toBe(true);
    expect(report.owner.nonce).toBe(readOwner(config, home).nonce);
    expect(report.requiresOwnership).toBe(true);
    expect(report.ageSeconds).toBeGreaterThanOrEqual(0);
    if (hasFlock) {
      expect(report.guard.present).toBe(true);
      expect(report.guard.held).toBe(false);
      expect(report.guard.inode).toBe(statSync(lock.guardFile(config).replace('$HOME', home)).ino);
    }
    expect(snapshotTree(home)).toEqual(before);
  });

  it('does not create the state dir or the guard when nothing was ever acquired', () => {
    const home = freshHome();
    const config = lockConfig();
    const report = lock.inspectLock(config, { runtime: runtimeFor(home) });
    expect(report.held).toBe(false);
    expect(report.owner).toBeNull();
    expect(report.guard.present).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  });

  it('is reachable as `deploy-kit lock inspect --json`', () => {
    const home = freshHome();
    const cwd = freshHome();
    writeFileSync(join(cwd, '.deploy-kit.config.json'), JSON.stringify({
      mode: 'local', appNames: ['brain636-lockown'], autoCut: false, onHost: { required: true },
    }));
    vi.stubEnv('HOME', home);
    const config = optedConfig();
    lock.acquireLock(config, { runtime: runtimeFor(home) });
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { lines.push(String(m)); });

    expect(cli.run(['lock', 'inspect', '--json'], { cwd })).toBe(0);
    const report = JSON.parse(lines.join('\n'));
    expect(report.held).toBe(true);
    expect(report.owner.nonce).toBe(readOwner(config, home).nonce);
    vi.unstubAllEnvs();
  });

  it('rejects other lock subcommands', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(cli.run(['lock', 'break'], { cwd: freshHome() })).toBe(1);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const lock = require('../lock.js') as typeof import('../lock');
const { mergeConfig, DEFAULT_CONFIG } = kit;

// lock.js writes state under a literal "$HOME" token that only the shell
// resolves at execution time (never Node). To exercise the REAL shell logic
// (mkdir/date/TTL math) without touching the developer's actual home
// directory, every runtime built here forces HOME to a throwaway temp dir via
// an env override on the *real* execFileSync -- this is the only way to
// genuinely watch the staleness/mode-700/migration behavior work (and fail),
// rather than hand-simulating what a shell would do.
function makeRealRuntime(homeDir: string) {
  const calls: string[] = [];
  const execFileSync = (file: string, args: string[], opts: any = {}) => {
    calls.push(args[args.length - 1]);
    return realExecFileSync(file, args, {
      ...opts,
      env: { ...process.env, HOME: homeDir },
      encoding: 'utf8',
      // Force pipe capture regardless of what runOnTarget requested, so tests
      // can inspect the script's own stdout (e.g. the stale-lock log line).
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  return { runtime: { execFileSync }, calls };
}

const lockConfig = (over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  mode: 'local', // runs via `sh -c` directly -- no ssh, no projectDir `cd`
  appNames: ['pkg82-locktest'],
  ...over,
});

const homeDirs: string[] = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-kit-lock-test-'));
  homeDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (homeDirs.length) {
    const dir = homeDirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('lock: state location', () => {
  it('acquires under $HOME/.deploy-kit (not /tmp), created mode 700', () => {
    const home = freshHome();
    const config = lockConfig();
    const { runtime } = makeRealRuntime(home);
    const release = lock.acquireLock(config, { runtime });

    // The lock/prev-sha paths themselves are no longer under /tmp (the only
    // /tmp reference allowed is the one-time legacy-migration read, asserted
    // separately below in the "backward-compat migration" suite).
    expect(lock.lockDir(config)).not.toMatch(/^\/tmp\//);
    expect(lock.prevShaFile(config)).not.toMatch(/^\/tmp\//);
    expect(lock.lockDir(config)).toMatch(/^\$HOME\/\.deploy-kit\//);

    const dir = lock.lockDir(config).replace('$HOME', home);
    const base = join(home, '.deploy-kit');
    expect(existsSync(dir)).toBe(true);
    expect(statSync(base).mode & 0o777).toBe(0o700);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    release();
    expect(existsSync(dir)).toBe(false);
  });
});

describe('lock: concurrent acquire', () => {
  it('acquires a fresh lock, then refuses a second concurrent acquire with the actionable message', () => {
    const home = freshHome();
    const config = lockConfig();
    const { runtime } = makeRealRuntime(home);
    const release = lock.acquireLock(config, { runtime });

    expect(() => lock.acquireLock(config, { runtime }))
      .toThrow(/Another deploy holds the lock .* --steal-lock/);

    release();
  });
});

describe('lock: staleness / TTL', () => {
  it('takes over a lock whose recorded timestamp is older than the TTL, logging that it did so', () => {
    const home = freshHome();
    const config = lockConfig({ stepTimeoutSeconds: 100 }); // ttl = 400s
    const { runtime } = makeRealRuntime(home);

    lock.acquireLock(config, { runtime }); // creates dir + pid/ts, held (not released)

    const dir = lock.lockDir(config).replace('$HOME', home);
    const ttl = lock.lockTtlSeconds(config);
    const staleTs = Math.floor(Date.now() / 1000) - ttl - 60; // 60s past the TTL
    writeFileSync(join(dir, 'ts'), String(staleTs));

    let output = '';
    const capturingRuntime = {
      execFileSync: (file: string, args: string[], opts: any = {}) => {
        output = realExecFileSync(file, args, {
          ...opts, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        return output;
      },
    };
    // A second, independent acquirer (not --steal-lock) succeeds because the
    // lock is stale.
    expect(() => lock.acquireLock(config, { runtime: capturingRuntime })).not.toThrow();
    expect(output).toMatch(/stale lock/);
    expect(output).toMatch(/taking it over/);
    expect(existsSync(join(dir, 'ts'))).toBe(true);
    const newTs = Number(readFileSync(join(dir, 'ts'), 'utf8').trim());
    expect(newTs).toBeGreaterThan(staleTs);
  });

  it('does NOT steal a lock that is within the TTL (the dangerous false-positive)', () => {
    const home = freshHome();
    const config = lockConfig({ stepTimeoutSeconds: 1800 }); // ttl = 7200s
    const { runtime } = makeRealRuntime(home);

    lock.acquireLock(config, { runtime }); // fresh: ts = now
    // A concurrent acquirer must still be refused -- the lock is well within TTL.
    expect(() => lock.acquireLock(config, { runtime }))
      .toThrow(/Another deploy holds the lock/);
  });
});

describe('lock: --steal-lock', () => {
  it('still forces past a held lock', () => {
    const home = freshHome();
    const config = lockConfig();
    const { runtime } = makeRealRuntime(home);

    lock.acquireLock(config, { runtime }); // held, fresh -- would normally block
    expect(() => lock.acquireLock(config, { runtime }, { steal: true })).not.toThrow();

    const dir = lock.lockDir(config).replace('$HOME', home);
    expect(existsSync(join(dir, 'pid'))).toBe(true);
  });
});

describe('lock: config.lock === false', () => {
  it('disables locking entirely -- no exec calls, acquire/release are pure no-ops', () => {
    const home = freshHome();
    const config = lockConfig({ lock: false });
    const { runtime, calls } = makeRealRuntime(home);

    const release = lock.acquireLock(config, { runtime });
    expect(calls.length).toBe(0);
    expect(existsSync(join(home, '.deploy-kit'))).toBe(false);
    release();
    expect(calls.length).toBe(0);
  });
});

describe('lock: backward-compat migration', () => {
  it('migrates a legacy /tmp prev-sha file into the new location on first acquire', () => {
    const home = freshHome();
    const config = lockConfig();
    const legacy = lock.legacyPrevShaFile(config); // real /tmp path (not $HOME-relative)
    const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    writeFileSync(legacy, `${sha}\n`);

    try {
      const { runtime } = makeRealRuntime(home);
      lock.acquireLock(config, { runtime });

      const newPath = lock.prevShaFile(config).replace('$HOME', home);
      expect(existsSync(newPath)).toBe(true);
      expect(readFileSync(newPath, 'utf8').trim()).toBe(sha);
    } finally {
      rmSync(legacy, { force: true });
    }
  });

  it('does not clobber a prev-sha already written post-upgrade', () => {
    const home = freshHome();
    const config = lockConfig();
    const legacy = lock.legacyPrevShaFile(config);
    writeFileSync(legacy, 'oldoldoldoldoldoldoldoldoldoldoldoldoldo\n');

    mkdirSync(join(home, '.deploy-kit'), { recursive: true, mode: 0o700 });
    const newPath = lock.prevShaFile(config).replace('$HOME', home);
    const currentSha = 'ffffffffffffffffffffffffffffffffffffffff';
    writeFileSync(newPath, `${currentSha}\n`);

    try {
      const { runtime } = makeRealRuntime(home);
      lock.acquireLock(config, { runtime });
      expect(readFileSync(newPath, 'utf8').trim()).toBe(currentSha);
    } finally {
      rmSync(legacy, { force: true });
    }
  });
});

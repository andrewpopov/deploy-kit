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

// deploy-kit drives its target through `sh -c`, and the lock is a POSIX shell
// construct: an atomic `mkdir`, a state dir created `mkdir -m 700 -p`, and
// rename-based disposal via `mv` + `rm -rf "$dir.stale.$$"`. On Windows that
// state dir step CREATES the directory and then fails to chmod it -
// "mkdir: cannot change permissions of '/c/Users/...': Permission denied",
// exit 1 - so every acquire aborts before its mkdir and reports the lock as
// held by someone else. Mode 700 is a real property on the Linux host these
// commands are built for (deploy state must not be world-readable), so it is
// not something to relax for a filesystem that cannot express it. These
// suites run for real wherever deploy-kit actually deploys.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

const { mergeConfig, DEFAULT_CONFIG, deploy } = kit;

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

describeOnPosix('lock: state location', () => {
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

describeOnPosix('lock: concurrent acquire', () => {
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

describeOnPosix('lock: staleness / TTL', () => {
  it('takes over a lock whose recorded timestamp is older than the TTL, logging that it did so', () => {
    const home = freshHome();
    const config = lockConfig({ stepTimeoutSeconds: 100 }); // ttl = 400s
    const { runtime } = makeRealRuntime(home);

    lock.acquireLock(config, { runtime }); // creates dir + pid/ts, held (not released)

    const dir = lock.lockDir(config).replace('$HOME', home);
    const ttl = lock.lockTtlSeconds(config);
    const staleTs = Math.floor(Date.now() / 1000) - ttl - 60; // 60s past the TTL
    writeFileSync(join(dir, 'ts'), String(staleTs));

    // acquireLock now makes TWO calls on success (the takeover script, then a
    // follow-up `cat` to read back the nonce it generated shell-side) -- capture
    // every call's output rather than a single variable so the takeover script's
    // own stdout survives past the later `cat`.
    const outputs: string[] = [];
    const capturingRuntime = {
      execFileSync: (file: string, args: string[], opts: any = {}) => {
        const out = realExecFileSync(file, args, {
          ...opts, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        outputs.push(String(out));
        return out;
      },
    };
    // A second, independent acquirer (not --steal-lock) succeeds because the
    // lock is stale.
    expect(() => lock.acquireLock(config, { runtime: capturingRuntime })).not.toThrow();
    const output = outputs.join('\n');
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

describeOnPosix('lock: --steal-lock', () => {
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

describe('lock: a transport/auth failure must never be reported as a held lock (PKG-127)', () => {
  // The clipd incident: ssh rejected with "Permission denied (publickey)" (no
  // authorized_keys for that account) — no lock existed on the host at all —
  // and deploy-kit reported "Another deploy holds the lock" and recommended
  // --steal-lock, which is useless against an auth failure and destructive
  // against a real one. The lock-acquire script (see lock.js) always completes
  // with a real `exit 1` when it genuinely determines the lock is held; ssh
  // failing to even reach the target exits some OTHER way (255 is ssh's own
  // connection/auth failure code; a spawn failure has no status at all).
  function makeTransportFailureRuntime(status: number | null) {
    const calls: string[] = [];
    const execFileSync = (_file: string, args: string[]) => {
      calls.push(args[args.length - 1]);
      const err: any = new Error('ssh: connect to host app failed: Permission denied (publickey).');
      if (status != null) err.status = status;
      throw err;
    };
    return { runtime: { execFileSync }, calls };
  }

  it('non-steal acquire: an ssh auth failure (exit 255) is surfaced as a connection failure, NOT a held lock', () => {
    const config = lockConfig();
    const { runtime } = makeTransportFailureRuntime(255);
    expect(() => lock.acquireLock(config, { runtime })).toThrow(/connection or authentication failure/);
    // Must NOT contain the lock-contention message or its dangerous suggestion.
    try {
      lock.acquireLock(config, { runtime });
      throw new Error('expected acquireLock to throw');
    } catch (e: any) {
      expect(e.message).not.toMatch(/Another deploy holds the lock/);
      expect(e.message).not.toMatch(/pass --steal-lock/);
      expect(e.message).toMatch(/Permission denied \(publickey\)/); // the real cause survives
    }
  });

  it('non-steal acquire: a spawn failure (no exit status at all, e.g. ssh missing) is also NOT reported as a held lock', () => {
    const config = lockConfig();
    const { runtime } = makeTransportFailureRuntime(null);
    expect(() => lock.acquireLock(config, { runtime })).not.toThrow(/Another deploy holds the lock/);
    expect(() => lock.acquireLock(config, { runtime })).toThrow(/connection or authentication failure/);
  });

  it('--steal-lock: an ssh auth failure is surfaced as a connection failure, NOT "lost a race"', () => {
    const config = lockConfig();
    const { runtime } = makeTransportFailureRuntime(255);
    expect(() => lock.acquireLock(config, { runtime }, { steal: true })).not.toThrow(/lost a race/);
    expect(() => lock.acquireLock(config, { runtime }, { steal: true })).toThrow(/connection or authentication failure/);
  });

  it('sanity: a CONFIRMED exit 1 (genuine remote script verdict) still gets the original, correct messages', () => {
    // Regression guard for the fix itself: only status===1 keeps the original
    // lock-contention wording; this must keep passing or the distinction above
    // is meaningless.
    const config = lockConfig();
    const confirmed = (message: string) => {
      const execFileSync = (_file: string, _args: string[]) => {
        const err: any = new Error(message);
        err.status = 1;
        throw err;
      };
      return { execFileSync };
    };
    expect(() => lock.acquireLock(config, { runtime: confirmed('fake failure') }))
      .toThrow(/Another deploy holds the lock .* --steal-lock/);
    expect(() => lock.acquireLock(config, { runtime: confirmed('fake failure') }, { steal: true }))
      .toThrow(/lost a race for the lock/);
  });
});

describeOnPosix('lock: takeover disposal is rename-based, not rm-before-mkdir (PKG-82 Blocker 1)', () => {
  // Two concurrent racers could previously both "win": A `rm -rf`s the stale
  // dir, A `mkdir`s (wins), A writes its owner file, then B's OWN `rm -rf`
  // (issued before it saw A's fresh mkdir) deletes A's brand-new lock, and B's
  // `mkdir` then also succeeds -- both exit 0. Fixed by disposing of the stale
  // dir via `mv` to a unique name (a single rename(2): only one racer's `mv`
  // can ever find the directory there) before the `rm -rf` and the `mkdir`
  // contest. Assert the emitted script reflects that shape for BOTH takeover
  // paths (TTL reclaim and --steal-lock).
  it('TTL-reclaim emits mv-then-rm disposal, never a bare rm -rf immediately before mkdir', () => {
    const home = freshHome();
    const config = lockConfig({ stepTimeoutSeconds: 100 }); // ttl = 400s
    const { runtime, calls } = makeRealRuntime(home);

    lock.acquireLock(config, { runtime }); // creates dir + pid/ts, held (not released)
    const dir = lock.lockDir(config).replace('$HOME', home);
    const ttl = lock.lockTtlSeconds(config);
    const staleTs = Math.floor(Date.now() / 1000) - ttl - 60;
    writeFileSync(join(dir, 'ts'), String(staleTs));

    lock.acquireLock(config, { runtime }); // TTL-reclaims via the stale branch
    // acquireLock's last call on success is now a follow-up `cat` reading back
    // the nonce it just wrote (see lock.js) -- the takeover script itself is the
    // one before it.
    const script = calls[calls.length - 2];

    expect(script).toMatch(/mv "[^"]+\.lock" "[^"]+\.lock\.stale\.\$\$" 2>\/dev\/null && rm -rf "[^"]+\.lock\.stale\.\$\$"/);
    // The dangerous old shape: `rm -rf "$dir"` with nothing but a newline before
    // the `mkdir` contest -- i.e. disposal and the mkdir race sharing no atomic
    // rename step in between.
    expect(script).not.toMatch(/rm -rf "[^"]+\.lock" 2>\/dev\/null\n\s*(if )?mkdir/);
  });

  it('--steal-lock emits the same mv-then-rm disposal', () => {
    const home = freshHome();
    const config = lockConfig({ appNames: ['pkg82-locktest-steal'] });
    const { runtime, calls } = makeRealRuntime(home);

    lock.acquireLock(config, { runtime }); // held, fresh
    lock.acquireLock(config, { runtime }, { steal: true });
    // acquireLock's last call on success is now a follow-up `cat` reading back
    // the nonce it just wrote (see lock.js) -- the takeover script itself is the
    // one before it.
    const script = calls[calls.length - 2];

    expect(script).toMatch(/mv "[^"]+\.lock" "[^"]+\.lock\.stale\.\$\$" 2>\/dev\/null && rm -rf "[^"]+\.lock\.stale\.\$\$"/);
    expect(script).not.toMatch(/rm -rf "[^"]+\.lock" 2>\/dev\/null\n\s*if mkdir/);
  });
});

describeOnPosix('lock: release() only removes a lock it still owns (PKG-82 Blocker 3)', () => {
  it('does not delete a lock dir whose nonce no longer matches (already reclaimed by another run)', () => {
    const home = freshHome();
    const config = lockConfig();
    const { runtime } = makeRealRuntime(home);

    const release = lock.acquireLock(config, { runtime }); // run A acquires
    const dir = lock.lockDir(config).replace('$HOME', home);
    expect(existsSync(join(dir, 'nonce'))).toBe(true);

    // Simulate: the lock was TTL-reclaimed by another run (B) while A believed
    // it still held it -- B's nonce now lives at this same path.
    writeFileSync(join(dir, 'nonce'), 'someone-elses-nonce');

    release(); // A's release -- must NOT delete B's lock.
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, 'nonce'), 'utf8').trim()).toBe('someone-elses-nonce');
  });

  it('still releases normally when the nonce matches (the common, non-raced case)', () => {
    const home = freshHome();
    const config = lockConfig();
    const { runtime } = makeRealRuntime(home);

    const release = lock.acquireLock(config, { runtime });
    const dir = lock.lockDir(config).replace('$HOME', home);
    release();
    expect(existsSync(dir)).toBe(false);
  });
});

// Stays enabled on Windows on purpose: this proves that disabling the lock
// performs NO shell operations at all, which is platform-independent and is
// exactly the regression that would bite here - code accidentally taking the
// POSIX lock path when it was told not to.
describe('lock: config.lock === false', () => {
  it('disables the lock itself -- acquire/release make no LOCK exec calls (no dir/mkdir/rm for the lock path)', () => {
    const home = freshHome();
    const config = lockConfig({ lock: false });
    const { runtime, calls } = makeRealRuntime(home);

    // acquireLock is a pure no-op with lock:false -- it returns before running
    // any script at all. State-dir creation/migration for prev-sha recording is
    // NOT tied to this: it is a separate, exported fragment (ensureStateDir)
    // that the caller who actually needs it (deploy.js) runs independently --
    // see the "lock: false regression" suite below for that half of the fix.
    const release = lock.acquireLock(config, { runtime });
    expect(calls.length).toBe(0);
    expect(existsSync(join(home, '.deploy-kit'))).toBe(false);
    release();
    expect(calls.length).toBe(0);
  });
});

describeOnPosix('lock: false still records a prev-sha (PKG-82 Blocker 2 regression)', () => {
  it('the "Recording current revision" step ensures $HOME/.deploy-kit itself, regardless of the lock setting', () => {
    // acquireLock never runs a single script when lock:false (see above), and
    // $HOME/.deploy-kit was previously created ONLY as a side effect of
    // acquiring a lock -- so a lock:false deploy silently never created it, the
    // prev-sha redirect at deploy.js failed silently (tolerate:true), and a
    // later `rollback` died with "No recorded previous revision" at exactly the
    // moment an operator needed it. Prove the fix at the pipeline level: the
    // record-revision command deploy.js actually emits must ensure the state
    // dir itself, in the same command, independent of any lock call.
    const calls: string[] = [];
    const fakeRuntime = {
      execFileSync: (_file: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        if (cmd.includes('curl')) return '200'; // health check
        return '';
      },
    };
    const config = mergeConfig(DEFAULT_CONFIG, {
      mode: 'local',
      projectDir: '/srv/pkg82-blocker2',
      appNames: [],
      lock: false,
    });

    deploy(config, { skipDeps: true, skipBuild: true, skipMigrate: true, stash: false }, {
      runtime: fakeRuntime,
      sleep: () => {},
    });

    // No lock calls at all (config.lock === false).
    expect(calls.some((c) => c.includes('.lock'))).toBe(false);

    const recordCmd = calls.find((c) => c.includes('git rev-parse HEAD >'));
    expect(recordCmd).toBeDefined();
    expect(recordCmd).toContain('mkdir -m 700 -p "$HOME/.deploy-kit"');
  });
});

describeOnPosix('lock: backward-compat migration', () => {
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

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const release = require('../release.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'; // 40 hex

// A content-aware fake execFileSync for the release pipeline. Each capture() call in
// release.js needs a plausible answer (marker, SHA, timestamp, pm2 jlist, /proc cwd,
// df, mv --version, …); everything else returns ''. `fail` forces a thrown failure
// for any command containing one of its substrings (simulates a step erroring).
function makeReleaseRuntime(over: any = {}) {
  const cfg = {
    marker: '{"layout":"releases","version":1}',
    mvVersion: 'mv (GNU coreutils) 9.1',
    dfAvail: '99999999',
    ts: '20260710T090000Z',
    sha: SHA,
    builtSha: SHA,
    canonical: '/srv/app/releases/a1b2c3d4e5f6a1b2-20260710T090000Z',
    runningSha: SHA,
    restartTime: 5,
    backupId: '/var/lib/smarthome/backups/smarthome-20260710T090000Z.db.gpg', // absolute path, the real shape
    releasesList: 'a1b2c3d4e5f6a1b2-20260710T090000Z\n00000000aaaa-20260709T090000Z\n00000000bbbb-20260708T090000Z',
    currentLink: 'releases/00000000aaaa-20260709T090000Z',
    previousLink: 'releases/00000000bbbb-20260708T090000Z',
    tracked: '',
    stateContent: '', // what `cat .deploy-kit-state.json` returns (interrupted-deploy guard)
    fail: [] as string[],
    ...over,
  };
  const calls: string[] = [];
  // Model PM2 stop/start so the GATED, verified writer-stop can be exercised: a
  // `pm2 stop` marks apps stopped; a start/restart brings them back online.
  const stopped = new Set<string>();
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cfg.fail.some((f: string) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      throw err;
    }
    if (/pm2 stop /.test(cmd)) { if (!cfg.stopIneffective) stopped.add('app'); return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { stopped.clear(); return ''; }
    if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return cfg.stateContent;
    if (cmd.includes('.deploy-kit-layout')) return cfg.marker;
    if (cmd.includes('mv --version')) return cfg.mvVersion;
    if (cmd.includes('df -kP')) return cfg.dfAvail; // fake stands in for the awk-extracted avail column
    if (cmd.includes('date -u')) return cfg.ts;
    if (cmd.includes('rev-parse HEAD')) return cfg.builtSha;
    if (cmd.includes('rev-parse')) return cfg.sha;
    if (cmd.includes('readlink -f')) return cfg.canonical;
    if (cmd.includes('pm2 jlist')) {
      return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: stopped.has('app') ? 'stopped' : 'online', restart_time: cfg.restartTime } }]);
    }
    if (cmd.includes('readlink ') && cmd.includes('/current')) return cfg.currentLink;
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return cfg.previousLink;
    if (cmd.includes('ls -1')) return cfg.releasesList;
    if (cmd.includes('git ls-files')) return cfg.tracked;
    if (cmd.includes('get-running-sha')) return cfg.runningSha;
    if (cmd.includes('run-backup')) return cfg.backupId;
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { runtime: { execFileSync }, calls, cfg };
}

const relConfig = (over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  dbBoundApps: ['app'],
  branch: 'master',
  ecosystemFile: 'shared/ecosystem.config.cjs',
  health: { attempts: 2, delaySeconds: 0 },
  hooks: {
    install: 'npm ci',
    build: 'npm run build',
    backup: 'run-backup',
    migrate: 'run-migrate',
    restore: 'run-restore',
  },
  layout: {
    type: 'releases',
    keepReleases: 4,
    sharedPaths: ['.env'],
    releaseChecks: [{ name: 'prisma-client-loads', command: 'check-prisma' }],
    runningShaCommand: 'get-running-sha',
  },
  ...over,
});

const ctx = (runtime: any) => ({ runtime, sleep: () => {} });

describe('release deploy — happy path', () => {
  it('builds inside the release, then flips current atomically', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const result = release.deployRelease(relConfig(), {}, ctx(runtime));
    expect(result.steps).toEqual(
      ['materialize', 'shared', 'install', 'build', 'validate', 'backup', 'migrate', 'flip', 'health', 'prune'],
    );
    expect(result.sha).toBe(SHA);
    expect(result.release).toBe('a1b2c3d4e5f6-20260710T090000Z');
    const joined = calls.join('\n');
    // AC1: install/build run INSIDE the release dir, never in current.
    expect(calls.some((cmd) => /cd \/srv\/app\/releases\/.* npm ci/.test(cmd))).toBe(true);
    expect(calls.some((cmd) => /cd \/srv\/app\/current.*npm ci/.test(cmd))).toBe(false);
    // worktree materialized detached at the resolved SHA.
    expect(joined).toContain(`worktree add --detach /srv/app/releases/a1b2c3d4e5f6-20260710T090000Z ${SHA}`);
    // Fetch MUST use an explicit refspec so a `git clone --bare` repo (no configured
    // refspec) actually updates refs/heads/* — else it builds a stale sha (SMH-116).
    expect(joined).toContain("fetch --prune origin '+refs/heads/*:refs/heads/*'");
    // atomic activation via mv -Tf onto current.
    expect(calls.some((cmd) => /mv -Tf .*\/srv\/app\/current/.test(cmd))).toBe(true);
    // ordering: install → build → stop → backup → migrate → flip.
    const idx = (s: string) => calls.findIndex((cmd) => cmd.includes(s));
    expect(idx('npm ci')).toBeLessThan(idx('npm run build'));
    expect(idx('npm run build')).toBeLessThan(idx('pm2 stop app'));
    expect(idx('pm2 stop app')).toBeLessThan(idx('run-backup'));
    expect(idx('run-backup')).toBeLessThan(idx('run-migrate'));
    expect(idx('run-migrate')).toBeLessThan(calls.findIndex((cmd) => /mv -Tf .*\/current/.test(cmd)));
  });

  it('resolves the SHA from refs/heads/<branch> when origin/<branch> does not exist (bare clone)', () => {
    // `git clone --bare` maps heads->heads: origin/master does NOT resolve (rev-parse
    // echoes the literal arg), but refs/heads/master does. Deploy must still succeed.
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('rev-parse origin/master')) return 'origin/master'; // unresolved
        if (cmd.includes('rev-parse refs/heads/master')) return SHA;
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    const result = release.deployRelease(relConfig(), {}, ctx(runtime));
    expect(result.sha).toBe(SHA);
    expect(result.steps).toContain('flip');
  });

  it('prefers refs/heads over a STALE origin/<branch> (heads:heads fetch is authoritative)', () => {
    // If repo.git has a heads->remotes/origin refspec, origin/master is only updated by a
    // plain fetch — NOT our heads:heads fetch — so it can be stale after the remote moved.
    // refs/heads/master (force-updated by our fetch) is current and must win.
    const STALE = 'dead00000000dead00000000dead00000000dead';
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('rev-parse origin/master')) return STALE;       // stale remote-tracking ref
        if (cmd.includes('rev-parse refs/heads/master')) return SHA;      // current local head
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    const result = release.deployRelease(relConfig(), {}, ctx(runtime));
    expect(result.sha).toBe(SHA);       // current, NOT the stale origin sha
    expect(result.sha).not.toBe(STALE);
  });

  it('restarts from the stable ecosystem (never a baked release path) and verifies cwd', () => {
    const { runtime, calls } = makeReleaseRuntime();
    release.deployRelease(relConfig(), {}, ctx(runtime));
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart /srv/app/shared/ecosystem.config.cjs'))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('readlink -f /proc/111/cwd'))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('get-running-sha'))).toBe(true);
  });

  it('runs post-deploy checks and delivery events after activation', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const result = release.deployRelease(relConfig({
      postDeployChecks: [{ name: 'public-smoke', command: 'cd current && run-smoke' }],
      deliveryEvent: { command: 'cd current && emit-event' },
    }), {}, ctx(runtime));
    expect(result.steps).toContain('post-check:public-smoke');
    expect(result.steps).toContain('delivery-event');
    expect(calls.some((command) => command.includes('cd /srv/app && cd current && run-smoke'))).toBe(true);
    expect(calls.some((command) => command.includes('cd /srv/app && cd current && emit-event'))).toBe(true);
  });

  it('dispatches through the public deploy() when layout.type is releases', () => {
    const { runtime } = makeReleaseRuntime();
    const result = kit.deploy(relConfig(), {}, ctx(runtime));
    expect(result.release).toBe('a1b2c3d4e5f6-20260710T090000Z');
  });

  it('accepts a PID whose cwd is a SUBDIR of the release (real ecosystem shape)', () => {
    // smarthome-api runs with cwd <release>/packages/api, not the release root.
    const over: any = {};
    const rt = makeReleaseRuntime();
    const subdir = `${rt.cfg.canonical}/packages/api`;
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('readlink -f /proc/')) return subdir;
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    void over;
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).not.toThrow();
  });

  it('verifyActivation rejects a PID whose cwd is OUTSIDE the new release (stale process)', () => {
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('readlink -f /proc/')) return '/srv/app/releases/old1-20260709T090000Z';
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    const v = release.verifyActivation(relConfig(), release.releasePaths(relConfig()), SHA, rt.cfg.canonical, ctx(runtime));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not under/);
  });

  it('verifyActivation fails a crash loop (restart counts climbing across the settle window)', () => {
    let n = 0;
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('pm2 jlist')) {
          n += 1;
          return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: 'online', restart_time: 5 + n } }]);
        }
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    const v = release.verifyActivation(relConfig(), release.releasePaths(relConfig()), SHA, rt.cfg.canonical, ctx(runtime));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/crash loop/);
  });
});

describe('release deploy — failure recovery by phase', () => {
  it('install failure: current keeps serving, apps never stopped, candidate quarantined', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['npm ci'] });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/npm ci/);
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => /mv -Tf .*\/current/.test(cmd))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('worktree remove --force'))).toBe(true);
  });

  it('build failure: quarantines candidate, never stops apps or flips', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['npm run build'] });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow();
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('worktree remove --force'))).toBe(true);
  });

  it('release-check failure: candidate quarantined before the disruptive window', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['check-prisma'] });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow();
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => /mv -Tf .*\/current/.test(cmd))).toBe(false);
  });

  it('backup failure (writers stopped, nothing migrated): resumes previous, no DB restore', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['run-backup'] });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/backup failed/);
    expect(calls.some((cmd) => cmd.includes('run-migrate'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    // previous release brought back via the stable ecosystem.
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(true);
  });

  it('migration failure: restores the DB backup and resumes the previous release', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['run-migrate'] });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow();
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(true);
    expect(calls.some((cmd) => cmd.includes("DEPLOY_KIT_BACKUP_ID='/var/lib/smarthome/backups/smarthome-20260710T090000Z.db.gpg'"))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(true);
  });

  it('activation verify failure (SHA mismatch): flips back, restores DB, resumes previous', () => {
    const { runtime, calls } = makeReleaseRuntime({ runningSha: 'deadbeefdeadbeef' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/verification failed/);
    // flip back onto current happened (there are two mv -Tf onto current: forward + back)
    expect(calls.filter((cmd) => /mv -Tf .*\/current/.test(cmd)).length).toBeGreaterThanOrEqual(2);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(true);
  });

  it('escalates to MANUAL RECOVERY REQUIRED when a migration failed AND the restore also fails', () => {
    const { runtime } = makeReleaseRuntime({ fail: ['run-migrate', 'run-restore'] });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/MANUAL RECOVERY REQUIRED/);
  });

  it('preflight refuses a migrate hook with no backup or no restore hook', () => {
    const noBackup = relConfig({ hooks: { install: 'npm ci', build: 'npm run build', migrate: 'run-migrate', backup: null, restore: 'run-restore' } });
    expect(() => release.deployRelease(noBackup, {}, ctx(makeReleaseRuntime().runtime))).toThrow(/requires a .backup. hook/);
    const noRestore = relConfig({ hooks: { install: 'npm ci', build: 'npm run build', migrate: 'run-migrate', backup: 'run-backup', restore: null } });
    expect(() => release.deployRelease(noRestore, {}, ctx(makeReleaseRuntime().runtime))).toThrow(/requires a .restore. hook/);
  });
});

describe('release deploy — safety hardening (Codex review fixes)', () => {
  it('aborts if DB writers cannot be CONFIRMED stopped (never backs up over live writers)', () => {
    const { runtime, calls } = makeReleaseRuntime({ stopIneffective: true });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/could not confirm|Could not confirm/i);
    expect(calls.some((cmd) => cmd.includes('run-backup'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('run-migrate'))).toBe(false);
  });

  it('durably journals state (atomic write) before the atomic flip', () => {
    const rt = makeReleaseRuntime();
    release.deployRelease(relConfig(), {}, ctx(rt.runtime));
    const c = rt.calls;
    const firstStateWrite = c.findIndex((cmd) => /deploy-kit-state\.json\.tmp.*&& mv -f/.test(cmd));
    const flip = c.findIndex((cmd) => /mv -Tf .*\/current/.test(cmd));
    expect(firstStateWrite).toBeGreaterThanOrEqual(0);
    expect(firstStateWrite).toBeLessThan(flip);
  });

  it('rollback flips back to the original release when the target is unhealthy', () => {
    let verifyCwdCalls = 0;
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        // First activation-verify (the rollback target) sees a stale cwd → unhealthy;
        // the flip-back verify (original) sees a good cwd → healthy.
        if (cmd.includes('readlink -f /proc/')) {
          verifyCwdCalls += 1;
          return verifyCwdCalls <= 1 ? '/srv/app/releases/99999999cccc-20260101T000000Z' : rt.cfg.canonical;
        }
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    expect(() => release.rollbackRelease(relConfig(), {}, ctx(runtime))).toThrow(/restored the original release/);
  });

  it('refuses to start when a previous deploy was interrupted mid-disruptive-phase', () => {
    const { runtime, calls } = makeReleaseRuntime({ stateContent: '{"phase":"migrated","releaseId":"a1b2c3d4e5f6-20260710T010000Z","backupId":"backup-x"}' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/interrupted mid-"migrated"/);
    expect(calls.some((cmd) => cmd.includes('worktree add'))).toBe(false);
  });

  it('rejects a corrupt current pointer that tries to traverse out of releases/', () => {
    const { runtime } = makeReleaseRuntime({ currentLink: 'releases/..' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/not a safe releases\/<id> target/);
  });

  it('prune removes the oldest release beyond keepReleases, protecting current/previous', () => {
    const rt = makeReleaseRuntime({
      releasesList: '00000000aaaa-20260709T090000Z\n00000000bbbb-20260708T090000Z\n00000000cccc-20260707T090000Z\nnot-a-release-dir',
      currentLink: 'releases/00000000aaaa-20260709T090000Z',
      previousLink: 'releases/00000000bbbb-20260708T090000Z',
    });
    const cfg = relConfig({ layout: { type: 'releases', keepReleases: 2, sharedPaths: ['.env'], releaseChecks: [], runningShaCommand: 'get-running-sha' } });
    const noop = () => {};
    const pruneCtx = { runtime: rt.runtime, sleep: noop, log: { step: noop, warning: noop, success: noop, info: noop, error: noop, header: noop, divider: noop } };
    release.prune(cfg, release.releasePaths(cfg), '00000000aaaa-20260709T090000Z', pruneCtx);
    // oldest recognized (cccc) is removed; the unrecognized dir is left alone.
    expect(rt.calls.some((cmd) => cmd.includes('worktree remove --force /srv/app/releases/00000000cccc-20260707T090000Z'))).toBe(true);
    expect(rt.calls.some((cmd) => cmd.includes('not-a-release-dir'))).toBe(false);
    expect(rt.calls.some((cmd) => cmd.includes('worktree remove --force /srv/app/releases/00000000bbbb'))).toBe(false);
  });
});

describe('release deploy — preflight guards (each must fail by name)', () => {
  it('refuses a host with no layout marker', () => {
    const { runtime } = makeReleaseRuntime({ marker: '' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/requires a migrated host/);
  });
  it('refuses a marker with the wrong layout version', () => {
    const { runtime } = makeReleaseRuntime({ marker: '{"layout":"releases","version":99}' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/marker mismatch/);
  });
  it('refuses a target without GNU coreutils mv', () => {
    const { runtime } = makeReleaseRuntime({ mvVersion: 'mv (BusyBox v1.36)' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/GNU coreutils/);
  });
  it('refuses when free disk is below the threshold', () => {
    const { runtime } = makeReleaseRuntime({ dfAvail: '1024' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/Insufficient free disk/);
  });
  it('refuses release deploy without a stable ecosystemFile', () => {
    const { runtime } = makeReleaseRuntime();
    expect(() => release.deployRelease(relConfig({ ecosystemFile: null }), {}, ctx(runtime))).toThrow(/requires .ecosystemFile/);
  });
  it('refuses when the resolved SHA and the built SHA differ', () => {
    const { runtime } = makeReleaseRuntime({ builtSha: 'ffffffffffffffffffffffffffffffffffffffff' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/Candidate SHA/);
  });
  it('refuses a sharedPath that is tracked in the release', () => {
    const { runtime } = makeReleaseRuntime({ tracked: 'TRACKED' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/would hide a committed file/);
  });
});

describe('release rollback', () => {
  it('flips current back to the previous release with no reinstall/rebuild', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const result = release.rollbackRelease(relConfig(), {}, ctx(runtime));
    expect(result.release).toBe('releases/00000000bbbb-20260708T090000Z');
    expect(calls.some((cmd) => /mv -Tf .*\/current/.test(cmd))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('npm ci'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('npm run build'))).toBe(false);
  });
  it('refuses to roll back when no previous release is recorded', () => {
    const { runtime } = makeReleaseRuntime({ previousLink: '' });
    expect(() => release.rollbackRelease(relConfig(), {}, ctx(runtime))).toThrow(/No previous release/);
  });
});

describe('legacy path refuses a release-layout host', () => {
  it('aborts a legacy deploy when .deploy-kit-layout is present', () => {
    const calls: string[] = [];
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        if (cmd.includes('.deploy-kit-layout')) return 'RELEASE';
        if (cmd.includes('curl')) return '200';
        return '';
      },
    };
    const legacy = mergeConfig(DEFAULT_CONFIG, {
      host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master',
      hooks: { install: 'npm ci', migrate: 'run-migrate', build: 'npm run build' },
    });
    expect(() => kit.deploy(legacy, {}, ctx(runtime))).toThrow(/Refusing to run a legacy in-place deploy/);
    expect(calls.some((cmd) => cmd.includes('git pull'))).toBe(false);
  });
});

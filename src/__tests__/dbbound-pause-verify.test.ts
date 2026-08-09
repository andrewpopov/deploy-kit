// Coverage for the DB-bound app pause verification in deploy.js's legacy
// pipeline (PTRY-510). The pause step (`pm2 stop <dbBoundApps>`) is tolerant
// twice over (shell `|| true` AND `tolerate: true`) because a legitimate "not
// running"/"not registered" error must never fail a deploy — but that
// tolerance also meant a REAL failure to stop a writer fell straight through
// into the backup/migrate window (a writer left online during the snapshot
// can produce an inconsistent backup). `onlineAppNames` (pm2-state.js) now
// brackets the pause with two `pm2 jlist` reads and asserts none of the apps
// observed online BEFORE the attempt are still online AFTER it.
//
// PTRY-510 hardens this further: unreadable `pm2 jlist` state is no longer
// treated as "skip verification and proceed" — it is retried a bounded number
// of times and, if still unreadable, fails closed (abort before pausing
// anything if it happens before the pause; resume-then-abort if after).
// Recovery (`resumeDbApps`) also now resumes ONLY the apps observed running
// before the pause, and verifies the resume actually took.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const {
  mergeConfig, DEFAULT_CONFIG, deploy, makeLogger,
} = kit;

const baseConfig = mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  dbBoundApps: ['app'],
  branch: 'master',
  hooks: {
    install: 'npm ci', backup: 'npm run db:backup', migrate: 'npm run db:migrate', build: 'npm run build',
  },
});

// A fake execFileSync that records every command, fails any command matching
// an entry in `fail` (same shape as deploy-kit.test.ts's makeRuntime), and
// answers `pm2 jlist` from a queue of canned responses consumed in call
// order — one entry per `pm2 jlist` invocation, including every retry
// attempt (PTRY-510's bounded retry means a single logical "read" can consume
// more than one queue entry). A response past the end of the queue comes back
// as '' (unreadable), matching a real target that has simply stopped
// answering.
function makeRuntime({ jlistResponses = [] as string[], fail = [] as string[] } = {}) {
  const calls: string[] = [];
  let jlistIndex = 0;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (fail.some((f) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      err.status = 1;
      throw err;
    }
    if (cmd.includes('pm2 jlist')) {
      const response = jlistResponses[jlistIndex];
      jlistIndex += 1;
      return response !== undefined ? response : '';
    }
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { runtime: { execFileSync }, calls };
}

const onlineJlist = (name: string) => JSON.stringify([{ name, pid: 1, pm2_env: { status: 'online' } }]);
const stoppedJlist = (name: string) => JSON.stringify([{ name, pid: 1, pm2_env: { status: 'stopped' } }]);
const statusJlist = (name: string, status: string) =>
  JSON.stringify([{ name, pid: 1, pm2_env: { status } }]);
const mixedJlist = (entries: Record<string, string>) =>
  JSON.stringify(Object.entries(entries).map(([name, status], i) => ({ name, pid: i + 1, pm2_env: { status } })));

function ctxWith(runtime: unknown, extra: Record<string, unknown> = {}) {
  return { runtime, sleep: () => {}, ...extra };
}

// Positions (indices into `calls`) of every command containing `needle`.
function positionsOf(calls: string[], needle: string): number[] {
  return calls.reduce<number[]>((acc, c, i) => {
    if (c.includes(needle)) acc.push(i);
    return acc;
  }, []);
}

describe('deploy(): DB-bound app pause verification', () => {
  // The pm2 probe must carry its OWN short bound. Inheriting stepTimeoutSeconds
  // (default 1800s, and `null` = unbounded) would let three retries hold the
  // deploy lock for ~90 minutes, or hang forever — turning a safety check into
  // an availability risk.
  it('(o) the pm2 probe is bounded independently of stepTimeoutSeconds', () => {
    const seen: Array<{ cmd: string; timeout: number | undefined }> = [];
    let jlistIndex = 0;
    const execFileSync = (_file: string, args: string[], opts?: { timeout?: number }) => {
      const cmd = args[args.length - 1];
      seen.push({ cmd, timeout: opts?.timeout });
      if (cmd.includes('pm2 jlist')) {
        // before-pause: online; after-pause: stopped (a clean, successful pause)
        return jlistIndex++ === 0 ? onlineJlist('app') : stoppedJlist('app');
      }
      if (cmd.includes('curl')) return '200';
      return '';
    };
    deploy(baseConfig, {}, ctxWith({ execFileSync }));

    const jlist = seen.filter((c) => c.cmd.includes('pm2 jlist'));
    expect(jlist.length).toBeGreaterThan(0);
    for (const call of jlist) expect(call.timeout).toBe(30_000);
    // A normal step still uses the inherited default, so this is probe-specific.
    const install = seen.find((c) => c.cmd.includes('npm ci'));
    expect(install?.timeout).toBe(1_800_000);
  });

  // The restart runs while dbBoundApps are still paused. A failed restart used
  // to abort straight through run(), leaving them stopped with nothing trying
  // to bring them back.
  it('(p) a failed restart still resumes the paused apps before aborting', () => {
    const { runtime, calls } = makeRuntime({
      jlistResponses: [onlineJlist('app'), stoppedJlist('app'), onlineJlist('app')],
      fail: ['pm2 start ecosystem.config.js', 'pm2 restart'],
    });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow(/Deploy aborted/);
    expect(calls.some((c) => c.includes('pm2 start app'))).toBe(true);
  });

  it('(a) app online before, still online after the pause -> deploy aborts and resumes paused apps', () => {
    // A 3rd response answers resumeDbApps' own post-resume verification read
    // (PTRY-510 Part 3): the resumed app reports back online.
    const { runtime, calls } = makeRuntime({
      jlistResponses: [onlineJlist('app'), onlineJlist('app'), onlineJlist('app')],
    });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime)))
      .toThrow(/DB-bound app\(s\) still running after the pause step \(app\)/);

    const jlistPositions = positionsOf(calls, 'pm2 jlist');
    const stopPosition = calls.findIndex((c) => c.includes('pm2 stop app'));
    const resumePosition = calls.findIndex((c) => c.includes('pm2 start app'));

    // Before the pause, after the pause attempt, and resumeDbApps' own
    // post-resume verification — three bracketing reads in total.
    expect(jlistPositions).toHaveLength(3);
    expect(jlistPositions[0]).toBeLessThan(stopPosition);
    expect(stopPosition).toBeLessThan(jlistPositions[1]);
    // Paused apps are resumed BEFORE the deploy aborts (same recovery contract
    // as every other gate in this window), and verified immediately after.
    expect(resumePosition).toBeGreaterThan(jlistPositions[1]);
    expect(resumePosition).toBeLessThan(jlistPositions[2]);
    // The abort happens before the backup/migrate — the entire point of the guard.
    expect(calls.some((c) => c.includes('db:backup'))).toBe(false);
    expect(calls.some((c) => c.includes('db:migrate'))).toBe(false);
  });

  it('(b) app online before, stopped after the pause -> deploy proceeds normally', () => {
    const { runtime, calls } = makeRuntime({ jlistResponses: [onlineJlist('app'), stoppedJlist('app')] });

    const result = deploy(baseConfig, {}, ctxWith(runtime));

    expect(result.healthy).toBe(true);
    expect(result.steps).toContain('backup');
    expect(result.steps).toContain('migrate');
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(2);
  });

  it('(c) nothing online before the pause -> proceeds, no post-pause assertion (single jlist read)', () => {
    const { runtime, calls } = makeRuntime({ jlistResponses: [stoppedJlist('app')] });

    const result = deploy(baseConfig, {}, ctxWith(runtime));

    expect(result.healthy).toBe(true);
    // Nothing was online before the attempt, so there is nothing to verify
    // after it — only the "before" read happens.
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(1);
  });

  // A process that is mid-launch or scheduled to restart can still write to the
  // database, so checking for `online` alone would let it slip past the pause
  // and into the backup window.
  it.each(['launching', 'one-launch-status', 'waiting restart', 'stopping'])(
    '(e) a %s app still in that state after the pause -> deploy aborts',
    (status) => {
      const { runtime, calls } = makeRuntime({
        jlistResponses: [statusJlist('app', status), statusJlist('app', status)],
      });

      expect(() => deploy(baseConfig, {}, ctxWith(runtime)))
        .toThrow(/DB-bound app\(s\) still running after the pause step \(app\)/);
      expect(calls.some((c) => c.includes('db:backup'))).toBe(false);
    },
  );

  // `errored` and `stopped` are the only states treated as definitely-not-writing.
  it('(f) an errored app is not treated as a writer -> deploy proceeds', () => {
    const { runtime, calls } = makeRuntime({ jlistResponses: [statusJlist('app', 'errored')] });

    const result = deploy(baseConfig, {}, ctxWith(runtime));

    expect(result.healthy).toBe(true);
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(1);
  });

  // pm2 prints update notices and deprecation warnings ahead of `jlist` JSON.
  // Failing open on a preamble would leave the pause silently unverified.
  it('(g) pm2 jlist with a non-JSON preamble is still parsed, and still aborts', () => {
    // pm2 prefixes its own notices with a literal "[PM2]", so the salvage must
    // not anchor on the first '[' it sees.
    const noisy = `[PM2] warning: something\n${onlineJlist('app')}`;
    const { runtime } = makeRuntime({ jlistResponses: [noisy, noisy, noisy] });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime)))
      .toThrow(/DB-bound app\(s\) still running after the pause step \(app\)/);
  });

  // `[PM2] warning []` must not salvage as "nothing is running" — that would
  // pass the verification silently instead of reporting unreadable output.
  // Genuinely unreadable input is retried (PTRY-510 Part 2); supply it on
  // every attempt so this exercises the SAME "still unreadable after
  // retrying" abort as the dedicated retry-exhaustion tests below.
  it('(h) a bracket pair inside pm2 noise is not mistaken for an empty process list -> retries then aborts', () => {
    const { runtime, calls } = makeRuntime({
      jlistResponses: ['[PM2] warning []', '[PM2] warning []', '[PM2] warning []'],
    });
    const warnings: string[] = [];
    const log = { ...makeLogger(() => {}, () => {}), warning: (m: string) => warnings.push(m) };

    expect(() => deploy(baseConfig, {}, ctxWith(runtime, { log })))
      .toThrow(/could not determine which DB-bound app\(s\) \(app\) were running/);
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(3);
    expect(calls.some((c) => c.includes('pm2 stop'))).toBe(false);
    expect(warnings.some((w) => /unreadable \(attempt 1\/3\)/.test(w))).toBe(true);
  });

  it('(d) unreadable pm2 jlist before the pause, exhausts retries -> aborts, nothing paused', () => {
    const { runtime, calls } = makeRuntime({ jlistResponses: ['not-json', 'not-json', 'not-json'] });
    const warnings: string[] = [];
    const log = { ...makeLogger(() => {}, () => {}), warning: (m: string) => warnings.push(m) };

    expect(() => deploy(baseConfig, {}, ctxWith(runtime, { log })))
      .toThrow(/could not determine which DB-bound app\(s\) \(app\) were running — `pm2 jlist` was unreadable after 3 attempts/);

    // All 3 retry attempts happened, and NOTHING was stopped — a clean abort
    // before the disruptive window opens.
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(3);
    expect(calls.some((c) => c.includes('pm2 stop'))).toBe(false);
    expect(calls.some((c) => c.includes('db:backup'))).toBe(false);
    expect(warnings.some((w) => /unreadable \(attempt 1\/3\); retrying/.test(w))).toBe(true);
    expect(warnings.some((w) => /unreadable \(attempt 2\/3\); retrying/.test(w))).toBe(true);
  });

  it('(i) unreadable pm2 jlist before the pause, succeeds on a retry -> proceeds normally', () => {
    // Two unreadable attempts, then a valid "online" read; a 4th response
    // answers the subsequent after-pause verification read.
    const { runtime, calls } = makeRuntime({
      jlistResponses: ['not-json', 'garbage', onlineJlist('app'), stoppedJlist('app')],
    });

    const result = deploy(baseConfig, {}, ctxWith(runtime));

    expect(result.healthy).toBe(true);
    expect(result.steps).toContain('backup');
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(4);
    expect(calls.some((c) => c.includes('pm2 stop app'))).toBe(true);
  });

  it('(j) unreadable pm2 jlist after the pause, exhausts retries -> resumes and aborts', () => {
    const { runtime, calls } = makeRuntime({
      jlistResponses: [onlineJlist('app'), 'not-json', 'not-json', 'not-json'],
    });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime)))
      .toThrow(/could not confirm DB-bound app\(s\) \(app\) stopped — `pm2 jlist` was unreadable after 3 attempts/);

    const jlistPositions = positionsOf(calls, 'pm2 jlist');
    const resumePosition = calls.findIndex((c) => c.includes('pm2 start app'));
    // 1 "before" read + 3 exhausted "after" retries + resumeDbApps' own
    // post-resume verification read (unconfirmed, since the queue is now
    // exhausted and comes back '' too) = 5.
    expect(jlistPositions).toHaveLength(5);
    // A resume was attempted before the abort — the pause DID stop something,
    // so this is not a no-op abort.
    expect(resumePosition).toBeGreaterThan(jlistPositions[3]);
    expect(resumePosition).toBeLessThan(jlistPositions[4]);
    expect(calls.some((c) => c.includes('db:backup'))).toBe(false);
  });

  it('(k) recovery resumes ONLY the apps observed running before the pause', () => {
    const cfg = mergeConfig(baseConfig, { dbBoundApps: ['app', 'worker'] });
    // before: app online, worker already stopped. after: both stopped (pause
    // verification passes cleanly). Then the backup fails, forcing a resume —
    // and a 3rd jlist answers resumeDbApps' own post-resume verification.
    const { runtime, calls } = makeRuntime({
      fail: ['db:backup'],
      jlistResponses: [
        mixedJlist({ app: 'online', worker: 'stopped' }),
        mixedJlist({ app: 'stopped', worker: 'stopped' }),
        onlineJlist('app'),
      ],
    });

    expect(() => deploy(cfg, {}, ctxWith(runtime))).toThrow(/Pre-migration database backup failed/);

    const resumeCommand = calls.find((c) => c.includes('pm2 start'));
    expect(resumeCommand).toContain('app');
    // worker was already stopped before this deploy — it must stay stopped.
    expect(resumeCommand).not.toContain('worker');
    expect(calls.some((c) => c.includes('pm2 start') && c.includes('worker'))).toBe(false);
  });

  // The degenerate edge of (k): NOTHING was observed running before the pause
  // (the whole app was already down for maintenance). A later failure must
  // resume nothing at all, not fall back to starting every configured
  // dbBoundApp — that fallback was a real bug caught while implementing this.
  it('(n) nothing observed running before the pause -> a later failure resumes nothing', () => {
    const { runtime, calls } = makeRuntime({
      fail: ['db:backup'],
      jlistResponses: [stoppedJlist('app')],
    });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow(/Pre-migration database backup failed/);

    // Only the single "before" read — nothing was online, so there is no
    // "after" verification and (since nothing was paused) no resume attempt.
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(1);
    expect(calls.some((c) => c.includes('pm2 start'))).toBe(false);
  });

  it('(l) a resume that does not come back is surfaced loudly, without masking the original failure', () => {
    // before: online (1 read). after: stopped, pause verification passes (1
    // read). migrate then fails, forcing a resume — but the 3rd read (the
    // resume's own verification) reports 'app' still stopped: the resume did
    // not take.
    const { runtime, calls } = makeRuntime({
      fail: ['db:migrate'],
      jlistResponses: [onlineJlist('app'), stoppedJlist('app'), stoppedJlist('app')],
    });
    const errors: string[] = [];
    const log = { ...makeLogger(() => {}, () => {}), error: (m: string) => errors.push(m) };

    // The ORIGINAL failure (migrate) is still what the deploy reports.
    expect(() => deploy(baseConfig, {}, ctxWith(runtime, { log })))
      .toThrow(/Running database migrations failed/);

    expect(calls.some((c) => c.includes('pm2 start app'))).toBe(true);
    // The recovery problem is reported SEPARATELY and loudly, not swallowed.
    expect(errors.some((e) => /RECOVERY INCOMPLETE/.test(e) && e.includes('app'))).toBe(true);
  });

  it('(m) --dry-run skips DB-bound pause verification entirely: no reads, no retries, never aborts', () => {
    const calls: string[] = [];
    let sleepCalls = 0;
    const runtime = {
      dryRun: true,
      execFileSync: (_file: string, args: string[]) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        // A real target is never actually touched under --dry-run in
        // production (cli.js's dry-run fake never calls through) — modeled
        // here by pm2 jlist always coming back unreadable, to prove the
        // dry-run path never even tries to read it (a retry-then-abort here
        // would be a regression: a dry run must never abort).
        if (cmd.includes('curl')) return '200';
        return '';
      },
    };
    const warnings: string[] = [];
    const log = { ...makeLogger(() => {}, () => {}), warning: (m: string) => warnings.push(m) };

    const result = deploy(baseConfig, {}, { runtime, sleep: () => { sleepCalls += 1; }, log });

    expect(result.healthy).toBe(true);
    expect(calls.some((c) => c.includes('pm2 stop app'))).toBe(true);
    expect(calls.some((c) => c.includes('pm2 jlist'))).toBe(false);
    expect(sleepCalls).toBe(0);
    expect(warnings.some((w) => /--dry-run: skipping DB-bound pause verification/.test(w))).toBe(true);
  });
});

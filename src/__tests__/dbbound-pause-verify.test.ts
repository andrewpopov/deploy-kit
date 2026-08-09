// Coverage for the DB-bound app pause verification in deploy.js's legacy
// pipeline. The pause step (`pm2 stop <dbBoundApps>`) is tolerant twice over
// (shell `|| true` AND `tolerate: true`) because a legitimate "not running"/
// "not registered" error must never fail a deploy — but that tolerance also
// meant a REAL failure to stop a writer fell straight through into the
// backup/migrate window (a writer left online during the snapshot can
// produce an inconsistent backup). `onlinePm2Apps` now brackets the pause
// with two `pm2 jlist` reads and asserts none of the apps observed online
// BEFORE the attempt are still online AFTER it.
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
// order: onlinePm2Apps is called once before the pause attempt and — only
// when something was observed online — once again after it, so
// `jlistResponses[0]` is always the "before" read and `jlistResponses[1]`
// (if present) is always the "after" read.
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
  it('(a) app online before, still online after the pause -> deploy aborts and resumes paused apps', () => {
    const { runtime, calls } = makeRuntime({ jlistResponses: [onlineJlist('app'), onlineJlist('app')] });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime)))
      .toThrow(/DB-bound app\(s\) still running after the pause step \(app\)/);

    const jlistPositions = positionsOf(calls, 'pm2 jlist');
    const stopPosition = calls.findIndex((c) => c.includes('pm2 stop app'));
    const resumePosition = calls.findIndex((c) => c.includes('pm2 start app'));

    // Exactly the two bracketing reads: before the pause attempt and after it.
    expect(jlistPositions).toHaveLength(2);
    expect(jlistPositions[0]).toBeLessThan(stopPosition);
    expect(stopPosition).toBeLessThan(jlistPositions[1]);
    // Paused apps are resumed BEFORE the deploy aborts (same recovery contract
    // as every other gate in this window).
    expect(resumePosition).toBeGreaterThan(jlistPositions[1]);
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
    const { runtime } = makeRuntime({ jlistResponses: [noisy, noisy] });

    expect(() => deploy(baseConfig, {}, ctxWith(runtime)))
      .toThrow(/DB-bound app\(s\) still running after the pause step \(app\)/);
  });

  it('(d) unreadable pm2 jlist -> proceeds, verification skipped and logged', () => {
    const { runtime, calls } = makeRuntime({ jlistResponses: ['not-json'] });
    const warnings: string[] = [];
    const log = { ...makeLogger(() => {}, () => {}), warning: (m: string) => warnings.push(m) };

    const result = deploy(baseConfig, {}, ctxWith(runtime, { log }));

    expect(result.healthy).toBe(true);
    // pm2 state was unknown before the attempt, so nothing is asserted and no
    // second read is even attempted.
    expect(positionsOf(calls, 'pm2 jlist')).toHaveLength(1);
    expect(warnings.some((w) => /pm2 jlist.*unreadable/i.test(w))).toBe(true);
  });
});

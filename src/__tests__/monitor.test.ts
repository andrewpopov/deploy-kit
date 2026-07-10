import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const monitorMod = require('../monitor.js');
const { monitor, stepCheck, EXIT } = monitorMod;
const { mergeConfig, DEFAULT_CONFIG } = kit;

const NOW = 1_800_000_000_000; // fixed clock (ms)

// A stateful fake runtime for the monitor: models pm2 jlist, df, stat, curl, the
// alert sink, and PERSISTS the monitor state file across calls (write captures the
// JSON piped over stdin; read returns it). Every command's last arg is the shell
// string; stdin data arrives as opts.input.
function makeMonitorRuntime(over: any = {}) {
  const cfg = {
    pm2: [
      { name: 'app', pid: 1, pm2_env: { status: 'online', restart_time: 5 } },
      { name: 'tun', pid: 2, pm2_env: { status: 'online' } },
    ] as any[],
    pm2Fails: false,
    dfAvail: '9999999',
    dfInodes: '999999',
    backupMtime: String(Math.floor(NOW / 1000)), // fresh now
    httpCode: '200',
    alertFails: false,
    ...over,
  };
  let stateStore = '';
  const calls: { cmd: string; input?: string }[] = [];
  const delivered: string[] = [];
  const execFileSync = (_file: string, args: string[], opts: any) => {
    const cmd = args[args.length - 1];
    calls.push({ cmd, input: opts && opts.input });
    if (/mkdir .*\.lock/.test(cmd) || /rmdir/.test(cmd)) return '';
    if (cmd.includes('cat >') && cmd.includes('monitor-state.json')) { stateStore = opts.input; return ''; }
    if (cmd.includes('cat ') && cmd.includes('monitor-state.json')) return stateStore;
    if (cmd.includes('ALERT-SINK')) { if (cfg.alertFails) throw new Error('sink failed'); delivered.push(opts && opts.input); return ''; }
    if (cmd.includes('pm2 jlist')) { if (cfg.pm2Fails) throw new Error('pm2 down'); return JSON.stringify(cfg.pm2); }
    if (cmd.includes('df -kP')) return cfg.dfAvail;
    if (cmd.includes('df -iP')) return cfg.dfInodes;
    if (cmd.includes('stat -c %Y')) return cfg.backupMtime;
    if (cmd.includes('%{http_code}')) return cfg.httpCode;
    return '';
  };
  return { runtime: { execFileSync }, calls, delivered, cfg, getState: () => (stateStore ? JSON.parse(stateStore) : null) };
}

const monConfig = (mon: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], tunnelName: 'tun',
  monitor: {
    disk: { minFreeKiB: 100, minFreeInodes: 100 },
    backup: { id: 'db', stampFile: '/var/lib/app/.last-success', maxAgeHours: 30 },
    restartStorm: { maxDelta: 3 },
    tunnel: true,
    publicProbes: [{ id: 'api', url: 'https://app/health', expectStatus: 200 }],
    alert: { command: 'ALERT-SINK', run: 'target' },
    failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 0,
    stateFile: '/var/lib/app/deploy-kit-monitor-state.json',
    ...mon,
  },
});

const noopLog = { info() {}, success() {}, warning() {}, error() {}, step() {}, header() {}, divider() {} };
const ctx = (rt: any, now = NOW) => ({ runtime: rt.runtime, log: noopLog, now: () => now, genId: () => 'evt-1' });

// ---------------- state machine (unit) ----------------
describe('monitor state machine (stepCheck)', () => {
  const opts = { failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 0, nowMs: NOW };
  it('debounces: no alert until failAfterRuns consecutive non-ok', () => {
    const s1 = stepCheck(undefined, { id: 'x', status: 'crit', message: 'down' }, opts);
    expect(s1.alert).toBeUndefined();
    expect(s1.next.failStreak).toBe(1);
    const s2 = stepCheck(s1.next, { id: 'x', status: 'crit', message: 'down' }, opts);
    expect(s2.alert).toMatchObject({ kind: 'alert', status: 'crit' });
    expect(s2.next.notif).toBe('alerted');
  });
  it('unknown HOLDS + PRESERVES streaks (failure → unknown → failure still reaches threshold)', () => {
    const s1 = stepCheck(undefined, { id: 'x', status: 'crit', message: 'd' }, opts); // failStreak 1
    const u = stepCheck(s1.next, { id: 'x', status: 'unknown', message: '?' }, opts);  // hold
    expect(u.alert).toBeUndefined();
    expect(u.next.failStreak).toBe(1);   // preserved, not reset
    expect(u.next.notif).toBe('healthy');
    const s2 = stepCheck(u.next, { id: 'x', status: 'crit', message: 'd' }, opts);      // failStreak 2 → alert
    expect(s2.alert).toMatchObject({ kind: 'alert' });
  });
  it('unknown does not recover an alerted check and carries the restart baseline forward', () => {
    const alerted = { notif: 'alerted', failStreak: 2, recoverStreak: 0, lastAlertAtMs: NOW, lastAlertedStatus: 'crit', meta: { restart: 42 } };
    const u = stepCheck(alerted as any, { id: 'restart:app', status: 'unknown', message: '?' }, opts);
    expect(u.next.notif).toBe('alerted');        // no false recovery
    expect(u.next.meta).toEqual({ restart: 42 }); // baseline preserved through unknown
  });
  it('recovers only after recoverAfterRuns consecutive ok', () => {
    const alerted = { notif: 'alerted', failStreak: 2, recoverStreak: 0, lastAlertAtMs: NOW, lastAlertedStatus: 'crit' };
    const r1 = stepCheck(alerted as any, { id: 'x', status: 'ok', message: 'up' }, opts);
    expect(r1.alert).toBeUndefined();
    const r2 = stepCheck(r1.next, { id: 'x', status: 'ok', message: 'up' }, opts);
    expect(r2.alert).toMatchObject({ kind: 'recovery' });
    expect(r2.next.notif).toBe('healthy');
  });
  it('escalates warn→crit immediately while alerted', () => {
    const alertedWarn = { notif: 'alerted', failStreak: 3, recoverStreak: 0, lastAlertAtMs: NOW, lastAlertedStatus: 'warn' };
    const e = stepCheck(alertedWarn as any, { id: 'x', status: 'crit', message: 'worse' }, opts);
    expect(e.alert).toMatchObject({ kind: 'escalation', status: 'crit' });
  });
  it('re-alerts a still-failing check after reAlertAfterMinutes', () => {
    const o = { ...opts, reAlertAfterMinutes: 10, nowMs: NOW + 11 * 60000 };
    const alerted = { notif: 'alerted', failStreak: 5, recoverStreak: 0, lastAlertAtMs: NOW, lastAlertedStatus: 'crit' };
    const rem = stepCheck(alerted as any, { id: 'x', status: 'crit', message: 'still down' }, o);
    expect(rem.alert).toMatchObject({ kind: 'reminder' });
  });
});

// ---------------- monitor() end-to-end ----------------
describe('monitor() run', () => {
  it('all healthy: no alerts, exit 0, state persisted', () => {
    const rt = makeMonitorRuntime();
    const res = monitor(monConfig(), {}, ctx(rt));
    expect(res.exitCode).toBe(EXIT.OK);
    expect(res.alerts).toEqual([]);
    expect(rt.delivered).toEqual([]);
    expect(rt.getState().pendingEvent).toBeNull();
  });

  it('crit sets exit 1 even before an alert fires (debounce)', () => {
    const rt = makeMonitorRuntime({ pm2: [{ name: 'app', pid: 0, pm2_env: { status: 'stopped', restart_time: 5 } }, { name: 'tun', pid: 2, pm2_env: { status: 'online' } }] });
    const res = monitor(monConfig(), {}, ctx(rt));
    expect(res.exitCode).toBe(EXIT.CRITICAL);
    expect(rt.delivered).toEqual([]); // failAfterRuns=2, first run stays quiet
  });

  it('batches all transitions into ONE alert event (no correlated storm)', () => {
    // app down + disk + public all fail; run twice to clear debounce.
    const down = { pm2: [{ name: 'app', pid: 0, pm2_env: { status: 'stopped', restart_time: 5 } }, { name: 'tun', pid: 2, pm2_env: { status: 'online' } }], dfAvail: '1', httpCode: '503' };
    const rt = makeMonitorRuntime(down);
    monitor(monConfig(), {}, ctx(rt));         // run 1 (debounce)
    const res = monitor(monConfig(), {}, ctx(rt)); // run 2 → alerts
    expect(rt.delivered.length).toBe(1);       // exactly one delivery
    const event = JSON.parse(rt.delivered[0]);
    const ids = event.alerts.map((a: any) => a.id).sort();
    expect(ids).toEqual(['disk:/srv/app', 'pm2:app', 'public:api']); // batched together
    expect(res.exitCode).toBe(EXIT.CRITICAL);
  });

  it('OUTBOX: a failed delivery retains the pending event and exits 2; next run delivers it', () => {
    const down = { pm2: [{ name: 'app', pid: 0, pm2_env: { status: 'stopped', restart_time: 5 } }, { name: 'tun', pid: 2, pm2_env: { status: 'online' } }], alertFails: true };
    const rt = makeMonitorRuntime(down);
    monitor(monConfig(), {}, ctx(rt));          // run1 debounce
    const r2 = monitor(monConfig(), {}, ctx(rt)); // run2: alert fires but sink FAILS
    expect(r2.exitCode).toBe(EXIT.MONITOR_ERROR);
    expect(rt.getState().pendingEvent).not.toBeNull();       // persisted BEFORE send, retained on failure
    expect(rt.getState().pendingEvent.alerts.some((a: any) => a.id === 'pm2:app')).toBe(true);
    // next run: sink recovers → the retained event is delivered and cleared
    rt.cfg.alertFails = false;
    monitor(monConfig(), {}, ctx(rt));
    expect(rt.delivered.length).toBe(1);
    expect(rt.getState().pendingEvent).toBeNull();
  });

  it('recovery fires after the app comes back (recoverAfterRuns) as one event', () => {
    const rt = makeMonitorRuntime({ pm2: [{ name: 'app', pid: 0, pm2_env: { status: 'stopped', restart_time: 5 } }, { name: 'tun', pid: 2, pm2_env: { status: 'online' } }] });
    monitor(monConfig(), {}, ctx(rt)); monitor(monConfig(), {}, ctx(rt)); // alert
    expect(rt.delivered.length).toBe(1);
    // app back online
    rt.cfg.pm2 = [{ name: 'app', pid: 9, pm2_env: { status: 'online', restart_time: 5 } }, { name: 'tun', pid: 2, pm2_env: { status: 'online' } }];
    monitor(monConfig(), {}, ctx(rt)); // recoverStreak 1
    const rec = monitor(monConfig(), {}, ctx(rt)); // recoverStreak 2 → recovery
    expect(rt.delivered.length).toBe(2);
    expect(JSON.parse(rt.delivered[1]).alerts[0].kind).toBe('recovery');
    expect(rec.exitCode).toBe(EXIT.OK);
  });

  it('restart-storm: alerts when restarts jump > maxDelta, re-baselines on a counter reset', () => {
    const rt = makeMonitorRuntime(); // restart_time 5 baseline
    monitor(monConfig({ failAfterRuns: 1 }), {}, ctx(rt)); // establish baseline (ok)
    rt.cfg.pm2 = [{ name: 'app', pid: 1, pm2_env: { status: 'online', restart_time: 20 } }, { name: 'tun', pid: 2, pm2_env: { status: 'online' } }];
    monitor(monConfig({ failAfterRuns: 1 }), {}, ctx(rt)); // delta 15 > 3 → alert
    expect(rt.delivered.some((d) => JSON.parse(d).alerts.some((a: any) => a.id === 'restart:app'))).toBe(true);
  });

  it('unknown pm2 does not alert nor recover (holds)', () => {
    const rt = makeMonitorRuntime({ pm2Fails: true });
    const res = monitor(monConfig(), {}, ctx(rt));
    expect(rt.delivered).toEqual([]);
    // pm2 unknown → results carry 'unknown', exit not CRITICAL from pm2 alone
    expect(res.results.find((r: any) => r.id === 'pm2:app').status).toBe('unknown');
  });

  it('refuses to overwrite state on a read ERROR (permission/I/O), not a missing file', () => {
    const rt = makeMonitorRuntime();
    const orig = rt.runtime.execFileSync;
    // Fail the state READ (present-file cat path) — must NOT reset+overwrite.
    (rt.runtime as any).execFileSync = (f: string, a: string[], o: any) => {
      const cmd = a[a.length - 1];
      if (cmd.includes('__DK_ABSENT__') || (cmd.includes('cat ') && cmd.includes('monitor-state.json') && !cmd.includes('cat >'))) throw new Error('permission denied');
      return orig(f, a, o);
    };
    expect(() => monitor(monConfig(), {}, ctx(rt))).toThrow(/could not read state file/);
    expect(rt.delivered).toEqual([]); // nothing written/sent
  });

  it('retires state for a check that is no longer configured (no false recovery)', () => {
    const rt = makeMonitorRuntime();
    // seed state with a stale alerted check that current config won't produce
    monitor(monConfig(), {}, ctx(rt));
    const st = rt.getState();
    st.checks['public:gone'] = { notif: 'alerted', failStreak: 3, recoverStreak: 0, lastAlertAtMs: NOW, lastAlertedStatus: 'crit' };
    (rt as any).runtime.execFileSync('sh', ['-c', 'cat > /var/lib/app/deploy-kit-monitor-state.json'], { input: JSON.stringify(st) });
    monitor(monConfig(), {}, ctx(rt));
    expect(rt.getState().checks['public:gone']).toBeUndefined(); // retired
    expect(rt.delivered).toEqual([]);                            // no false recovery alert
  });
});

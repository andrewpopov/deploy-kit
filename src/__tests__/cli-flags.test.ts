import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'stream';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const require = createRequire(__filename);
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number>; parseOptions: Function };
const remote = require('../remote.js') as Record<string, (...a: any[]) => any>;
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

// PKG-82: parseOptions() only knows a flag PARSES; it says nothing about
// whether the dispatched command actually READS it. Before this fix,
// `deploy-kit stop --dry-run` parsed fine and then called remote.stop(config)
// for real (BWK-136 failure mode). These tests prove the new per-command
// flag guard in cli.js rejects every unsupported flag by name, and that a
// rejection means the handler is never reached at all — not just a wrong
// exit code.

// No .deploy-kit.config.json here — every rejection in this file must happen
// BEFORE loadConfig runs, so a nonexistent cwd proves the point.
const NO_CONFIG_CWD = '/nonexistent/pkg-82-cli-flags-test-cwd';

// Same pattern as alert-discord.test.ts / port-guard.test.ts: capture every
// log.* call so we can assert on the exact message a rejection produced.
function captureLog(): { out: () => string; restore: () => void } {
  let out = '';
  const sink = (m: string): void => { out += String(m) + '\n'; };
  const spies = ['error', 'success', 'info', 'step', 'header', 'warning', 'divider'].map((m) =>
    log[m] ? vi.spyOn(log, m).mockImplementation(sink) : null,
  );
  return { out: () => out, restore: () => { for (const s of spies) s?.mockRestore(); } };
}

function withConfig(config: Record<string, unknown>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-cli-flags-'));
  fs.writeFileSync(path.join(dir, '.deploy-kit.config.json'), JSON.stringify(config));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('production-safety canary: stop --dry-run', () => {
  it('is rejected, names the flag, and NEVER calls remote.stop', () => {
    const stopSpy = vi.spyOn(remote, 'stop');
    const cap = captureLog();
    const code = cli.run(['stop', '--dry-run'], { cwd: NO_CONFIG_CWD, env: {} });
    const out = cap.out();
    cap.restore();

    expect(code).toBe(1);
    expect(stopSpy).not.toHaveBeenCalled();
    expect(out).toMatch(/stop does not support: --dry-run/);
  });

  it('sanity check: the spy seam itself works — a VALID stop call does reach remote.stop', () => {
    const stopSpy = vi.spyOn(remote, 'stop').mockReturnValue(true);
    const code = cli.run(['stop'], { cwd: NO_CONFIG_CWD, env: {} });
    expect(code).toBe(0);
    expect(stopSpy).toHaveBeenCalledTimes(1);
  });
});

describe('rejected flags: one per command family, message names the flag', () => {
  const cases: Array<[string[], RegExp]> = [
    // deploy/rollback family — rollback never reads skipMigrate/stash (src/deploy.js:314)
    [['rollback', '--skip-migrate'], /rollback does not support: --skip-migrate/],
    [['rollback', '--no-stash'], /rollback does not support: --no-stash/],
    // monitor family — monitor never reads dryRun
    [['monitor', '--dry-run'], /monitor does not support: --dry-run/],
    // remote PM2 verbs — take no flags at all
    [['status', '--steal-lock'], /status does not support: --steal-lock/],
    [['health', '--dry-run'], /health does not support: --dry-run/],
    [['dashboard', '--no-lock'], /dashboard does not support: --no-lock/],
    [['resources', '--skip-build'], /resources does not support: --skip-build/],
    [['git', '--follow'], /git does not support: --follow/],
    [['start', '--dry-run'], /start does not support: --dry-run/],
    [['restart', '--steal-lock'], /restart does not support: --steal-lock/],
    // logs — takes --lines/--follow/--errors only
    [['logs', '--dry-run'], /logs does not support: --dry-run/],
    [['logs', '--skip-build'], /logs does not support: --skip-build/],
    // init — takes nothing
    [['init', '--dry-run'], /init does not support: --dry-run/],
    // standalone utilities — take only --webhook-env/--service
    [['alert-discord', '--skip-build'], /alert-discord does not support: --skip-build/],
    [['announce-discord', '--skip-deps'], /announce-discord does not support: --skip-deps/],
    // host-operations family
    [['run-host-operations', '--action', 'X', '--dry-run'], /run-host-operations does not support: --dry-run/],
    [['run-cairn-operations', '--action', 'X'], /run-cairn-operations does not support: --action/],
  ];

  for (const [argv, expected] of cases) {
    it(`\`${argv.join(' ')}\` is rejected with exit 1 and names the flag`, () => {
      const cap = captureLog();
      const code = cli.run(argv, { cwd: NO_CONFIG_CWD, env: {} });
      const out = cap.out();
      cap.restore();
      // Every rejection here is synchronous (a plain number), never a Promise —
      // a Promise would mean dispatch happened before the flag was checked.
      expect(code).toBe(1);
      expect(out).toMatch(expected);
    });
  }

  it('run-cairn-operations names ALL three unsupported generic flags, not just one', () => {
    // It takes none of run-host-operations' generic flags — this is the
    // deprecated-alias contract the old special-cased check used to enforce;
    // it is now handled by the same generic COMMAND_FLAGS table.
    const cap = captureLog();
    const code = cli.run(['run-cairn-operations', '--action', 'X', '--api-url-env', 'Y', '--api-key-env', 'Z'], {
      cwd: NO_CONFIG_CWD, env: {},
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(1);
    expect(out).toMatch(/--action/);
    expect(out).toMatch(/--api-url-env/);
    expect(out).toMatch(/--api-key-env/);
    expect(out).toMatch(/run-host-operations --action NAME/); // the actionable hint survives
  });
});

describe('PTRY-489: monitor --local', () => {
  it('`deploy --local` is rejected as an unknown flag (monitor-only)', () => {
    const cap = captureLog();
    const code = cli.run(['deploy', '--local'], { cwd: NO_CONFIG_CWD, env: {} });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(1);
    expect(out).toMatch(/deploy does not support: --local/);
  });

  it('`monitor --local` parses and dispatches (not flag-rejected)', () => {
    const cap = captureLog();
    const code = cli.run(['monitor', '--local'], { cwd: NO_CONFIG_CWD, env: {} });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(2); // no `monitor` config block in this cwd's (nonexistent) config
    expect(out).not.toMatch(/does not support/);
    expect(out).toMatch(/No `monitor` config block/);
  });

  it('with --local, the config reaching monitor() has mode "local" even though the file says ssh', () => {
    withConfig({ host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], mode: 'ssh', monitor: { disk: { minFreeKiB: 1, minFreeInodes: 1 }, alert: { command: 'ALERT-SINK' } } }, (dir) => {
      const monitorMod = require('../monitor.js');
      const spy = vi.spyOn(monitorMod, 'monitor').mockReturnValue({ exitCode: 0 });
      const code = cli.run(['monitor', '--local'], { cwd: dir, env: {} });
      expect(code).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1);
      const [config] = spy.mock.calls[0];
      expect(config.mode).toBe('local');
      expect(config.host).toBe('app@pi'); // host is untouched — still the target identity
      spy.mockRestore();
    });
  });

  it('without --local, a committed ssh-mode config reaches monitor() unchanged', () => {
    withConfig({ host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], mode: 'ssh', monitor: { disk: { minFreeKiB: 1, minFreeInodes: 1 }, alert: { command: 'ALERT-SINK' } } }, (dir) => {
      const monitorMod = require('../monitor.js');
      const spy = vi.spyOn(monitorMod, 'monitor').mockReturnValue({ exitCode: 0 });
      const code = cli.run(['monitor'], { cwd: dir, env: {} });
      expect(code).toBe(0);
      const [config] = spy.mock.calls[0];
      expect(config.mode).toBe('ssh');
      spy.mockRestore();
    });
  });
});

describe('no regression: every currently-valid invocation still dispatches', () => {
  it('deploy with every one of its real flags + --dry-run completes (exit 0)', () => {
    withConfig({ host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], mode: 'ssh' }, (dir) => {
      const code = cli.run(
        ['deploy', '--skip-build', '--skip-deps', '--skip-migrate', '--no-stash', '--dry-run', '--steal-lock', '--no-lock'],
        { cwd: dir, env: {} },
      );
      expect(code).toBe(0);
    });
  });

  it('rollback with its real flags + --dry-run reaches real rollback logic (not flag-rejected)', () => {
    withConfig({ host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], mode: 'ssh' }, (dir) => {
      const cap = captureLog();
      const code = cli.run(
        ['rollback', '--skip-deps', '--skip-build', '--dry-run', '--steal-lock', '--no-lock'],
        { cwd: dir, env: {} },
      );
      const out = cap.out();
      cap.restore();
      // The dry-run fake runtime returns '' for the recorded-SHA file read, so
      // rollback legitimately fails with "no recorded revision" — that failure
      // is proof the command WAS dispatched, not proof of a flag rejection.
      expect(code).toBe(1);
      expect(out).not.toMatch(/does not support/);
      expect(out).toMatch(/No recorded previous revision/);
    });
  });

  it('monitor accepts --steal-lock (dispatches into the real monitor gate, not rejected)', () => {
    const cap = captureLog();
    const code = cli.run(['monitor', '--steal-lock'], { cwd: NO_CONFIG_CWD, env: {} });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(2); // no `monitor` config block in this cwd's (nonexistent) config
    expect(out).not.toMatch(/does not support/);
    expect(out).toMatch(/No `monitor` config block/);
  });

  it('the zero-flag remote PM2 commands still dispatch to their remote.* handler', () => {
    const table: Array<[string, keyof typeof remote]> = [
      ['status', 'status'],
      ['health', 'health'],
      ['dashboard', 'dashboard'],
      ['resources', 'resources'],
      ['git', 'gitInfo'],
      ['start', 'start'],
      ['restart', 'restart'],
    ];
    for (const [command, fnName] of table) {
      const spy = vi.spyOn(remote, fnName).mockReturnValue(true);
      const code = cli.run([command], { cwd: NO_CONFIG_CWD, env: {} });
      expect(code, `${command} exit code`).toBe(0);
      expect(spy, `remote.${fnName} called for ${command}`).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    }
  });

  it('logs accepts --lines/--follow/--errors and passes them through to remote.logs', () => {
    const spy = vi.spyOn(remote, 'logs').mockReturnValue(true);
    const code = cli.run(['logs', '--lines', '10', '--follow', '--errors'], { cwd: NO_CONFIG_CWD, env: {} });
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
    const [, options] = spy.mock.calls[0];
    expect(options).toMatchObject({ lines: 10, follow: true, errors: true });
  });

  it('alert-discord / announce-discord / run-host-operations still dispatch (return a Promise) with their real flags', async () => {
    const stdin1 = Readable.from([JSON.stringify({ eventId: 'x', createdAtMs: 1, host: 'h', alerts: [] })]);
    const r1 = cli.run(['alert-discord', '--webhook-env', 'SOME_VAR', '--service', 'svc'], { cwd: NO_CONFIG_CWD, env: {}, stdin: stdin1 });
    expect(r1).toBeInstanceOf(Promise);
    await r1;

    const stdin2 = Readable.from([JSON.stringify({ eventId: 'x', createdAtMs: 1, host: 'h' })]);
    const r2 = cli.run(['announce-discord', '--webhook-env', 'SOME_VAR', '--service', 'svc'], { cwd: NO_CONFIG_CWD, env: {}, stdin: stdin2 });
    expect(r2).toBeInstanceOf(Promise);
    await r2;

    const r3 = cli.run(['run-host-operations', '--action', 'DEPLOY_STAGING', '--api-url-env', 'X', '--api-key-env', 'Y'], {
      cwd: NO_CONFIG_CWD, env: {},
    });
    expect(r3).toBeInstanceOf(Promise);
    await r3;
  });
});

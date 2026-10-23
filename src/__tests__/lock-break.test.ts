import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync, spawn, spawnSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const lock = require('../lock.js') as typeof import('../lock');
const lockBreak = require('../lock-break.js') as typeof import('../lock-break');
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number };

const { mergeConfig, DEFAULT_CONFIG } = kit as any;

const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;
const describeBreak = process.platform === 'win32' || !hasFlock ? describe.skip : describe;
const isRoot = process.getuid?.() === 0;

const UID = process.getuid?.() ?? 0;
const BOOT = 'aaaa1111-2222';
const OTHER_BOOT = 'bbbb3333-4444';
const UNIT = 'deploy-kit-run1.service';
const INV = 'abc123def456';

interface Fixture {
  home: string; proc: string; cg: string; bin: string; stub: string; bootFile: string; config: any;
}
const roots: string[] = [];

function fixture(over: any = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'deploy-kit-lockbreak-'));
  roots.push(home);
  const dirs = { proc: join(home, 'fakeproc'), cg: join(home, 'fakecg'), bin: join(home, 'bin'), stub: join(home, 'stub') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  mkdirSync(join(home, 'hosts'));
  const bootFile = join(home, 'boot_id');
  writeFileSync(bootFile, `${BOOT}\n`);
  writeFileSync(join(dirs.bin, 'systemctl'), '#!/bin/sh\n[ -e "$STUB_DIR/fail" ] && exit 1\ncat "$STUB_DIR/show"\n');
  chmodSync(join(dirs.bin, 'systemctl'), 0o755);
  const config = mergeConfig(DEFAULT_CONFIG, {
    mode: 'local',
    appNames: ['brain636-break'],
    autoCut: false,
    onHost: { required: true },
    hostLock: { dir: join(home, 'hosts'), key: 'bigpi' },
    ...over,
  });
  return { home, bootFile, config, ...dirs };
}

const envFor = (fx: Fixture, extra: Record<string, string> = {}) => ({
  ...process.env,
  HOME: fx.home,
  PATH: `${fx.bin}:${process.env.PATH}`,
  STUB_DIR: fx.stub,
  DEPLOY_KIT_TEST_PROC_ROOT: fx.proc,
  DEPLOY_KIT_TEST_CGROUP_ROOT: fx.cg,
  DEPLOY_KIT_TEST_BOOT_ID_FILE: fx.bootFile,
  ...extra,
});

function runtimeFor(fx: Fixture, extra: Record<string, string> = {}) {
  const execFileSync = (file: string, args: string[], opts: any = {}) => realExecFileSync(file, args, {
    ...opts, env: envFor(fx, extra), encoding: 'utf8', stdio: [opts.input != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  return { execFileSync };
}

const appLock = (fx: Fixture) => lock.lockDir(fx.config).replace('$HOME', fx.home);
const hostLock = (fx: Fixture) => lock.hostLockDir(fx.config);

function ownerRecord(over: Record<string, unknown> = {}) {
  return {
    kind: 'unit', uid: UID, user: 'tester', bootId: BOOT, unit: UNIT, invocationId: INV, pid: 4242,
    pstart: 777, sid: 4242, runId: 'run1', nonce: 'n0nce1', purpose: null, ...over,
  };
}

// Plant a held lock directory carrying `owner` (as acquireLock would have written it).
function plant(dir: string, owner: Record<string, unknown> | null) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (owner) writeFileSync(join(dir, 'owner'), `${JSON.stringify(owner)}\n`);
  writeFileSync(join(dir, 'ts'), `${Math.floor(Date.now() / 1000)}\n`);
  if (owner) writeFileSync(join(dir, 'nonce'), `${owner.nonce}\n`);
}

const show = (fx: Fixture, over: Record<string, string> = {}) => {
  const f = {
    LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', InvocationID: INV, Job: '', ...over,
  };
  writeFileSync(join(fx.stub, 'show'), Object.entries(f).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
};

const cgroupPath = (fx: Fixture) => join(
  fx.cg, 'user.slice', `user-${UID}.slice`, `user@${UID}.service`, 'app.slice', UNIT,
);
const cgroup = (fx: Fixture, populated: 0 | 1) => {
  mkdirSync(cgroupPath(fx), { recursive: true });
  writeFileSync(join(cgroupPath(fx), 'cgroup.events'), `populated ${populated}\nfrozen 0\n`);
};
const runResult = (fx: Fixture, invocationId = INV, file = 'result.json') => {
  const dir = join(fx.home, '.deploy-kit', 'runs', 'run1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), `{"runId":"run1","invocationId":"${invocationId}","serviceResult":"success","exitCode":"exited","exitStatus":"0","finishedAt":1}\n`);
};

// A /proc/<pid>/stat line with the session id (field 6) and start time (field 22) set.
const procEntry = (fx: Fixture, pid: number, { sid, start }: { sid: number; start: number }) => {
  const fields = Array.from({ length: 52 }, () => '0');
  fields[0] = String(pid); fields[1] = '(odd) name)'; fields[2] = 'S'; fields[3] = '1'; fields[4] = String(sid);
  fields[5] = String(sid); fields[21] = String(start);
  mkdirSync(join(fx.proc, String(pid)), { recursive: true });
  writeFileSync(join(fx.proc, String(pid), 'stat'), `${fields.join(' ')}\n`);
};

function breakIt(fx: Fixture, options: Record<string, unknown> = {}) {
  return lockBreak.breakLock(fx.config, { runtime: runtimeFor(fx) }, {
    nonce: 'n0nce1', reason: 'owner confirmed dead', ...options,
  } as any);
}

const archives = (fx: Fixture, dir = appLock(fx)) => (existsSync(join(dir, '..')) ? readdirSync(join(dir, '..')) : [])
  .filter((n) => n.startsWith(`${dir.split('/').pop()}.broken.`));
const evidence = (fx: Fixture) => {
  const dir = join(fx.home, '.deploy-kit', 'lock-breaks');
  return existsSync(dir) ? readdirSync(dir).map((n) => JSON.parse(readFileSync(join(dir, n), 'utf8'))) : [];
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function expectRefused(fx: Fixture, options: Record<string, unknown>, reason: RegExp) {
  const dir = options.host ? hostLock(fx) : appLock(fx);
  const before = existsSync(dir) ? readdirSync(dir).sort() : null;
  const result = breakIt(fx, options);
  expect(result.broken).toBe(false);
  expect(result.output).toMatch(reason);
  expect(existsSync(dir) ? readdirSync(dir).sort() : null).toEqual(before);
  expect(archives(fx, dir)).toEqual([]);
  expect(evidence(fx)).toEqual([]);
}

describeBreak('lock break: kind unit, same boot', () => {
  const proven = (over: Record<string, string> = {}) => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord());
    show(fx, over);
    cgroup(fx, 0);
    return fx;
  };

  it('breaks an inactive unit with a matching invocation, no job and an empty cgroup', () => {
    const fx = proven();
    const result = breakIt(fx);
    expect(result.broken).toBe(true);
    expect(result.output).toMatch(/proof:.*unit deploy-kit-run1\.service invocation abc123def456 inactive\/dead.*populated 0/);
    expect(existsSync(appLock(fx))).toBe(false);
    const [archive] = archives(fx);
    expect(archive).toMatch(/^deploy-kit-brain636-break\.lock\.broken\.n0nce1\.\d+$/);
    expect(JSON.parse(readFileSync(join(appLock(fx), '..', archive, 'owner'), 'utf8')).nonce).toBe('n0nce1');
    const [record] = evidence(fx);
    expect(Object.keys(record).sort()).toEqual(['archive', 'at', 'by', 'lockPath', 'owner', 'proof', 'reason']);
    expect(record.owner.nonce).toBe('n0nce1');
    expect(record.reason).toBe('owner confirmed dead');
    expect(record.by).toBe(UID);
    expect(record.proof).toMatch(/populated 0/);
    expect(record.lockPath).toBe(appLock(fx));
  });

  it('accepts a failed unit', () => {
    expect(breakIt(proven({ ActiveState: 'failed', SubState: 'failed' })).broken).toBe(true);
  });

  it('keeps the guard inode, so the next acquirer contends on the same file', () => {
    const fx = proven();
    const guard = `${appLock(fx)}.guard`;
    writeFileSync(guard, '');
    const inode = statSync(guard).ino;
    expect(breakIt(fx).broken).toBe(true);
    expect(statSync(guard).ino).toBe(inode);
  });

  it.each([
    ['an active unit', { ActiveState: 'active', SubState: 'running' }, /ActiveState is 'active'/],
    ['an activating unit', { ActiveState: 'activating', SubState: 'start' }, /ActiveState is 'activating'/],
    ['a different invocation of the unit', { InvocationID: 'ffff0000' }, /InvocationID is 'ffff0000'/],
    ['a unit with a pending job', { Job: '412' }, /pending job \(412\)/],
    ['a unit in an unknown load state', { LoadState: 'error' }, /LoadState is 'error'/],
  ])('refuses %s', (_name, over, reason) => {
    const fx = proven(over);
    expectRefused(fx, {}, reason);
  });

  it('refuses a nested descendant still alive in the unit cgroup (populated 1)', () => {
    const fx = proven();
    cgroup(fx, 1);
    expectRefused(fx, {}, /cgroup .* is still populated/);
  });

  it('refuses when systemctl cannot report', () => {
    const fx = proven();
    writeFileSync(join(fx.stub, 'fail'), '');
    expectRefused(fx, {}, /systemctl --user show .* failed/);
  });

  it('refuses an unreadable cgroup.events', () => {
    if (isRoot) return;
    const fx = proven();
    chmodSync(join(cgroupPath(fx), 'cgroup.events'), 0o000);
    expectRefused(fx, {}, /cgroup\.events is unreadable/);
  });

  it('refuses a missing cgroup without a result file', () => {
    const fx = proven();
    rmSync(cgroupPath(fx), { recursive: true });
    expectRefused(fx, {}, /no cgroup for .* and no run result/);
  });

  it('refuses a missing cgroup when the result carries another invocation', () => {
    const fx = proven();
    rmSync(cgroupPath(fx), { recursive: true });
    runResult(fx, 'ffff0000');
    expectRefused(fx, {}, /no cgroup for .* and no run result/);
  });

  it('accepts a missing cgroup with a result carrying the invocation', () => {
    const fx = proven();
    rmSync(cgroupPath(fx), { recursive: true });
    runResult(fx);
    const result = breakIt(fx);
    expect(result.broken).toBe(true);
    expect(result.output).toMatch(/cgroup gone, run result carries invocation abc123def456/);
  });

  it('accepts an unloaded unit only with a matching result (result-unstarted counts)', () => {
    const fx = proven({ LoadState: 'not-found', ActiveState: 'inactive', InvocationID: '' });
    expectRefused(fx, {}, /not loaded and the run has no result/);
    runResult(fx, INV, 'result-unstarted.json');
    expect(breakIt(fx).broken).toBe(true);
  });

  it('refuses an unreadable run result rather than ignoring it', () => {
    if (isRoot) return;
    const fx = proven();
    runResult(fx);
    chmodSync(join(fx.home, '.deploy-kit', 'runs', 'run1', 'result.json'), 0o000);
    expectRefused(fx, {}, /run result .* is unreadable/);
  });

  it('refuses an owner record without a usable unit or invocation id', () => {
    const fx = proven();
    plant(appLock(fx), ownerRecord({ unit: null }));
    expectRefused(fx, {}, /no usable unit name/);
    plant(appLock(fx), ownerRecord({ invocationId: null }));
    expectRefused(fx, {}, /no usable invocation id/);
  });
});

describeBreak('lock break: kind session, same boot', () => {
  const session = (over: Record<string, unknown> = {}) => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ kind: 'session', unit: null, invocationId: null, ...over }));
    return fx;
  };

  it('breaks when the pid is gone and nothing is left in the session', () => {
    const fx = session();
    procEntry(fx, 99, { sid: 99, start: 5 });
    const result = breakIt(fx);
    expect(result.broken).toBe(true);
    expect(result.output).toMatch(/pid 4242 gone.*no process in session 4242/);
  });

  it('breaks when the pid was reused (different start time) and the session is empty', () => {
    const fx = session();
    procEntry(fx, 4242, { sid: 31, start: 778 });
    const result = breakIt(fx);
    expect(result.broken).toBe(true);
    expect(result.output).toMatch(/pid 4242 reused/);
  });

  it('refuses while the owner pid is alive with the recorded start time', () => {
    const fx = session();
    procEntry(fx, 4242, { sid: 31, start: 777 });
    expectRefused(fx, {}, /owner pid 4242 is still running/);
  });

  it('refuses while any process is still in the recorded session', () => {
    const fx = session();
    procEntry(fx, 5000, { sid: 4242, start: 12 });
    expectRefused(fx, {}, /still in session 4242/);
  });

  it('refuses when /proc cannot be read, and on an owner record without pid/pstart/sid', () => {
    const fx = session();
    rmSync(fx.proc, { recursive: true });
    expectRefused(fx, {}, /is not readable/);
    plant(appLock(fx), ownerRecord({ kind: 'session', pstart: null }));
    expectRefused(fx, {}, /lacks a numeric pid, pstart and sid/);
  });

  it('refuses a process stat file it cannot read', () => {
    if (isRoot) return;
    const fx = session();
    procEntry(fx, 5000, { sid: 5000, start: 1 });
    chmodSync(join(fx.proc, '5000', 'stat'), 0o000);
    expectRefused(fx, {}, /5000\/stat is unreadable/);
  });
});

describeBreak('lock break: kind legacy', () => {
  it('refuses without --legacy-owner-gone, and breaks with it, recording the reason', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ kind: 'legacy', unit: null, invocationId: null }));
    expectRefused(fx, {}, /pass --legacy-owner-gone/);
    const result = breakIt(fx, { legacyOwnerGone: true, reason: 'host rebooted? no: ps shows nothing' });
    expect(result.broken).toBe(true);
    expect(result.output).toMatch(/legacy owner asserted gone/);
    expect(evidence(fx)[0].reason).toBe('host rebooted? no: ps shows nothing');
    expect(evidence(fx)[0].proof).toMatch(/legacy owner asserted gone/);
  });

  it('refuses an owner kind it does not know', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ kind: 'wizard' }));
    expectRefused(fx, {}, /kind 'wizard'/);
  });
});

describeBreak('lock break: different boot', () => {
  it('is sufficient on its own: no systemctl, cgroup, result or proc needed', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    rmSync(join(fx.bin, 'systemctl'));
    rmSync(fx.proc, { recursive: true });
    const result = breakIt(fx);
    expect(result.broken).toBe(true);
    expect(result.output).toMatch(new RegExp(`boot differs: owner boot ${OTHER_BOOT}, now ${BOOT}`));
    expect(existsSync(appLock(fx))).toBe(false);
  });

  it.each(['session', 'legacy'])('applies to a %s owner too, without the legacy flag', (kind) => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ kind, bootId: OTHER_BOOT }));
    expect(breakIt(fx).broken).toBe(true);
  });

  it('still needs the current boot id to be readable', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    rmSync(fx.bootFile);
    expectRefused(fx, {}, /cannot read the current boot id/);
  });

  it('does not treat an owner record with no boot id as a reboot', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ kind: 'legacy', bootId: null }));
    expectRefused(fx, {}, /pass --legacy-owner-gone/);
  });
});

describeBreak('lock break: refusals before any proof', () => {
  it('refuses when the caller is not the owner uid, whatever the evidence says', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ uid: UID + 1, bootId: OTHER_BOOT }));
    expectRefused(fx, {}, new RegExp(`running as uid ${UID}, the lock owner is uid ${UID + 1}`));
  });

  it('refuses an owner record with no numeric uid', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ uid: null, bootId: OTHER_BOOT }));
    expectRefused(fx, {}, /no numeric uid/);
  });

  it('refuses a nonce that is not the owner\'s', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    expectRefused(fx, { nonce: 'someone-else' }, /nonce is 'n0nce1', not 'someone-else'/);
  });

  it('refuses when there is no lock, and when the owner record is missing', () => {
    const fx = fixture();
    expectRefused(fx, {}, /no lock at/);
    plant(appLock(fx), null);
    expectRefused(fx, {}, /owner record .* missing or unreadable/);
  });

  it('rejects a malformed nonce and an empty reason before running anything', () => {
    const fx = fixture();
    expect(() => breakIt(fx, { nonce: 'a b; rm -rf /' })).toThrow(/--nonce must match/);
    expect(() => breakIt(fx, { reason: '  ' })).toThrow(/non-empty --reason/);
  });

  it('keeps shell metacharacters in the reason out of the shell and in the evidence verbatim', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    const reason = 'it\'s "dead"; $(touch pwned) `id` \\ done';
    expect(breakIt(fx, { reason }).broken).toBe(true);
    expect(evidence(fx)[0].reason).toBe(reason);
    expect(existsSync(join(fx.home, 'pwned'))).toBe(false);
  });
});

describeBreak('lock break: --host', () => {
  it('breaks the host lock and leaves the app lock alone', () => {
    const fx = fixture();
    plant(hostLock(fx), ownerRecord({ bootId: OTHER_BOOT, nonce: 'hostnonce' }));
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT, nonce: 'appnonce' }));
    expect(breakIt(fx, { nonce: 'hostnonce', host: true }).broken).toBe(true);
    expect(existsSync(hostLock(fx))).toBe(false);
    expect(existsSync(appLock(fx))).toBe(true);
    expect(archives(fx, hostLock(fx))).toHaveLength(1);
    expect(evidence(fx)[0].lockPath).toBe(hostLock(fx));
  });

  it('refuses the app lock\'s nonce against the host lock', () => {
    const fx = fixture();
    plant(hostLock(fx), ownerRecord({ bootId: OTHER_BOOT, nonce: 'hostnonce' }));
    expectRefused(fx, { nonce: 'appnonce', host: true }, /not 'appnonce'/);
  });

  it('throws when the config has no hostLock', () => {
    const fx = fixture({ hostLock: undefined });
    expect(() => breakIt(fx, { host: true })).toThrow(/needs a hostLock/);
  });
});

// Spawn the break script itself (not breakLock) so a test can hold it mid-flight.
function spawnBreaker(fx: Fixture, extraEnv: Record<string, string> = {}, options: Record<string, unknown> = {}) {
  const script = lockBreak.buildBreakScript(fx.config, { nonce: 'n0nce1', reason: 'race', ...options } as any);
  const child = spawn('sh', ['-se'], { env: envFor(fx, extraEnv), stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end(script);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise<{ code: number | null; out: string }>((resolve) => {
    child.on('close', (code) => resolve({ code, out }));
  });
  return { child, done };
}
const waitFor = async (path: string) => {
  for (let i = 0; i < 400 && !existsSync(path); i += 1) await new Promise((r) => setTimeout(r, 25));
  expect(existsSync(path)).toBe(true);
};

describeBreak('lock break: concurrency under the guard', () => {
  it('breaker B, paused after its first look, refuses once A broke and C acquired; C is never touched', async () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    const hold = join(fx.home, 'hold');

    const b = spawnBreaker(fx, { DEPLOY_KIT_TEST_BREAK_HOLD: hold });
    await waitFor(`${hold}.reached`);

    expect(breakIt(fx).broken).toBe(true); // A breaks the owner B inspected
    expect(existsSync(appLock(fx))).toBe(false);
    const release = lock.acquireLock(fx.config, { runtime: runtimeFor(fx) }, { kind: 'legacy', runId: 'cc' }); // C acquires
    const cOwner = readFileSync(join(appLock(fx), 'owner'), 'utf8');
    const cInode = statSync(appLock(fx)).ino;
    expect(JSON.parse(cOwner).nonce).not.toBe('n0nce1');

    writeFileSync(`${hold}.go`, '');
    const result = await b.done;

    expect(result.code).toBe(lockBreak.REFUSED_EXIT);
    expect(result.out).toMatch(/refused: lock owner nonce is '[0-9a-f]+', not 'n0nce1'/);
    expect(statSync(appLock(fx)).ino).toBe(cInode);
    expect(readFileSync(join(appLock(fx), 'owner'), 'utf8')).toBe(cOwner);
    expect(archives(fx)).toHaveLength(1); // only A's
    expect(evidence(fx)).toHaveLength(1);
    release();
  });

  it('a breaker waits for whoever holds the guard, and re-checks after it', async () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    const guard = `${appLock(fx)}.guard`;
    writeFileSync(guard, '');
    const holder = spawn('sh', ['-c', `exec 9>> "${guard}"; flock -x 9; echo held; sleep 1.2`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((resolve) => { holder.stdout.once('data', () => resolve()); });
    const started = Date.now();
    const result = await spawnBreaker(fx).done;
    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('several breakers racing the same lock: exactly one wins', async () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    const results = await Promise.all(Array.from({ length: 6 }, () => spawnBreaker(fx).done));
    expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    expect(results.filter((r) => r.code === lockBreak.REFUSED_EXIT)).toHaveLength(5);
    expect(archives(fx)).toHaveLength(1);
    expect(evidence(fx)).toHaveLength(1);
  });
});

describeBreak('deploy-kit lock break (CLI)', () => {
  const cliFor = (fx: Fixture, args: string[]) => {
    const cwd = join(fx.home, 'cwd');
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, '.deploy-kit.config.json'), JSON.stringify({
      mode: 'local', appNames: ['brain636-break'], autoCut: false, onHost: { required: true },
    }));
    vi.stubEnv('HOME', fx.home);
    vi.stubEnv('PATH', `${fx.bin}:${process.env.PATH}`);
    vi.stubEnv('STUB_DIR', fx.stub);
    vi.stubEnv('DEPLOY_KIT_TEST_PROC_ROOT', fx.proc);
    vi.stubEnv('DEPLOY_KIT_TEST_CGROUP_ROOT', fx.cg);
    vi.stubEnv('DEPLOY_KIT_TEST_BOOT_ID_FILE', fx.bootFile);
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: string) => { lines.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { code: cli.run(['lock', 'break', ...args], { cwd }), lines };
  };

  it('exits 3 on a refusal and 0 once broken, printing the proof', () => {
    const fx = fixture();
    plant(appLock(fx), ownerRecord({ bootId: OTHER_BOOT }));
    const refused = cliFor(fx, ['--nonce', 'wrong', '--reason', 'r']);
    expect(refused.code).toBe(3);
    expect(refused.lines.join('\n')).toMatch(/refused: lock owner nonce/);
    const broken = cliFor(fx, ['--nonce', 'n0nce1', '--reason', 'r']);
    expect(broken.code).toBe(0);
    expect(broken.lines.join('\n')).toMatch(/proof: boot differs/);
  });

  it.each([[[]], [['--nonce', 'x']], [['--reason', 'x']], [['--nonce', 'x', '--reason', 'y', '--bogus']], [['--nonce']]])(
    'is a usage error (1) for %j', (args) => {
      expect(cliFor(fixture(), args as string[]).code).toBe(1);
    },
  );
});

// TODO(BRAIN-636, run on bigpi during P0): these need real processes and users and cannot be
// run (or honestly faked) on a Mac; the cases above only prove the shell logic against stubs.
//  - a real transient `systemd-run --user` unit (KillMode=process): kill its main process, leave a
//    live child in the cgroup, and confirm `lock break` refuses (cgroup populated 1), then kill
//    the child and confirm it breaks.
//  - the same with the unit's parent (host-run) SIGKILLed: InvocationID matches, ActiveState goes
//    inactive/failed, and the real cgroup path layout under user@<uid>.service matches the `find`.
//  - real `systemctl --user show -p Job` output while a stop job is queued (property present vs
//    omitted), and the LoadState of a garbage-collected transient unit.
//  - a D3 `setsid` session owner: kill the leader, keep a session member alive, confirm refusal on
//    /proc/*/stat field 6; then reap it and confirm the break.
//  - two real users: a second account runs `lock break` against the first's lock and is refused on
//    uid, and the first account's break succeeds.
//  - a real reboot: lock left from before the boot with the old boot_id, `lock break` succeeds
//    with no cgroup and no result.
//  - flock(1) contention across hosts' real util-linux flock versus Homebrew's flock (semantics are
//    the same, but the P0 box is the one that matters).

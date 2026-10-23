import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync, statSync, readFileSync,
} from 'fs';
import { join } from 'path';
import {
  hasFlock, hasProc, freshHome, runtimeFor, appConfig, put, read, readJson, exists, dkPath, lockPathFor,
  holdAppLock, cleanupHomes, REQUEST_ID, RUN_ID,
} from './target-state-fixture';

const require = createRequire(__filename);
const ts = require('../target-state.js');
const lock = require('../lock.js');

const describeWithFlock = process.platform === 'win32' || !hasFlock ? describe.skip : describe;
afterEach(cleanupHomes);

const fixedNow = new Date('2026-10-23T12:00:00Z');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim();
function repoWithCommit(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  writeFileSync(join(dir, 'f'), 'x');
  git(dir, 'add', 'f');
  git(dir, 'commit', '-qm', 'c');
  return git(dir, 'rev-parse', 'HEAD');
}

describeWithFlock('hold set / clear', () => {
  it('writes {reason, until, at, epoch} atomically and releases the lock, keeping the guard inode', () => {
    const home = freshHome();
    const config = appConfig();
    const runtime = runtimeFor(home);
    const result = ts.setHold(config, { reason: 'cutover "now"', until: '2026-10-24T00:00:00Z', now: fixedNow, runtime });

    expect(result.outcome).toBe('ok');
    const file = `deploy-kit-${lock.lockId(config)}.hold.json`;
    expect(readJson(home, file)).toEqual({ reason: 'cutover "now"', until: '2026-10-24T00:00:00Z', at: fixedNow.toISOString(), epoch: null });
    expect(existsSync(lockPathFor(config, home))).toBe(false);
    expect(existsSync(lock.guardFile(config).replace('$HOME', home))).toBe(true);
    expect(readdirSync(dkPath(home, '')).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('records the current epoch, and an open-ended hold has until null', () => {
    const home = freshHome();
    const config = appConfig();
    put(home, '.last-epoch', '7\n');
    ts.setHold(config, { reason: 'r', now: fixedNow, runtime: runtimeFor(home) });
    expect(readJson(home, `deploy-kit-${lock.lockId(config)}.hold.json`)).toMatchObject({ until: null, epoch: 7 });
  });

  it('clear removes the hold, and clearing nothing is fine', () => {
    const home = freshHome();
    const config = appConfig();
    const runtime = runtimeFor(home);
    ts.setHold(config, { reason: 'r', runtime });
    expect(ts.clearHold(config, { runtime }).outcome).toBe('ok');
    expect(exists(home, `deploy-kit-${lock.lockId(config)}.hold.json`)).toBe(false);
    expect(ts.clearHold(config, { runtime }).outcome).toBe('ok');
    expect(existsSync(lockPathFor(config, home))).toBe(false);
  });

  it('refuses an empty reason and a non-ISO --until before touching the target', () => {
    const config = appConfig();
    expect(() => ts.setHold(config, { reason: ' ', runtime: runtimeFor(freshHome()) })).toThrow(/reason/);
    expect(() => ts.setHold(config, { reason: 'r', until: 'tomorrow-ish', runtime: runtimeFor(freshHome()) })).toThrow(/ISO/);
  });

  it('target-state evaluates the expiry: past until is expired, future and open-ended are not', () => {
    const home = freshHome();
    const config = appConfig();
    const runtime = runtimeFor(home);
    const holdFile = `deploy-kit-${lock.lockId(config)}.hold.json`;
    const read1 = () => ts.readTargetState(config, { runtime, now: fixedNow }).hold;

    expect(read1()).toBeNull();
    put(home, holdFile, { reason: 'r', until: '2026-10-23T11:59:59Z', at: 'x', epoch: null });
    expect(read1()).toMatchObject({ reason: 'r', expired: true });
    put(home, holdFile, { reason: 'r', until: '2026-10-23T12:00:01Z', at: 'x', epoch: 3 });
    expect(read1()).toMatchObject({ expired: false, epoch: 3 });
    put(home, holdFile, { reason: 'r', until: null, at: 'x', epoch: null });
    expect(read1()).toMatchObject({ until: null, expired: false });
    put(home, holdFile, '{not json');
    expect(read1()).toMatchObject({ corrupt: true });
    put(home, holdFile, { reason: '', until: null, at: 'x', epoch: null });
    expect(read1()).toMatchObject({ corrupt: true });
  });
});

describeWithFlock('epoch set', () => {
  const epochOf = (home: string) => read(home, '.last-epoch').trim();

  it('sets from nothing, raises, and treats equal as a no-op', () => {
    const home = freshHome();
    const config = appConfig();
    const runtime = runtimeFor(home);
    expect(ts.setEpoch(config, 3, { runtime })).toMatchObject({ outcome: 'ok', message: 'epoch set 3' });
    expect(epochOf(home)).toBe('3');
    expect(ts.setEpoch(config, '10', { runtime }).outcome).toBe('ok');
    expect(epochOf(home)).toBe('10');
    const before = statSync(dkPath(home, '.last-epoch')).ino;
    expect(ts.setEpoch(config, 10, { runtime })).toMatchObject({ outcome: 'ok', message: 'epoch unchanged 10' });
    expect(statSync(dkPath(home, '.last-epoch')).ino).toBe(before);
  });

  it('refuses to lower the value and leaves the file alone', () => {
    const home = freshHome();
    const config = appConfig();
    const runtime = runtimeFor(home);
    ts.setEpoch(config, 5, { runtime });
    const result = ts.setEpoch(config, 4, { runtime });
    expect(result.outcome).toBe('refused');
    expect(result.message).toBe('refused epoch-lower current=5 requested=4');
    expect(epochOf(home)).toBe('5');
    expect(existsSync(lockPathFor(config, home))).toBe(false);
  });

  it('compares numerically, not as text', () => {
    const home = freshHome();
    const runtime = runtimeFor(home);
    ts.setEpoch(appConfig(), 9, { runtime });
    expect(ts.setEpoch(appConfig(), 10, { runtime }).outcome).toBe('ok');
    expect(ts.setEpoch(appConfig(), 9, { runtime }).outcome).toBe('refused');
  });

  it('refuses a non-integer before touching the target', () => {
    const runtime = runtimeFor(freshHome());
    for (const bad of ['abc', '1.5', '-1', '', '007', '1e3', '1234567890123456', ' 3']) {
      expect(() => ts.setEpoch(appConfig(), bad, { runtime }), bad).toThrow(/epoch/);
    }
  });

  it('a corrupt .last-epoch refuses instead of being overwritten', () => {
    const home = freshHome();
    put(home, '.last-epoch', 'seven');
    const result = ts.setEpoch(appConfig(), 9, { runtime: runtimeFor(home) });
    expect(result).toMatchObject({ outcome: 'refused', message: 'refused epoch-corrupt' });
    expect(epochOf(home)).toBe('seven');
  });
});

describeWithFlock('the lock session', () => {
  it('fails fast with refused lock-held and the owner record when the app lock is taken; changes nothing', () => {
    const home = freshHome();
    const config = appConfig();
    holdAppLock(config, home, 'run-holder');
    const started = Date.now();
    const result = ts.setHold(config, { reason: 'r', runtime: runtimeFor(home) });

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.outcome).toBe('lock-held');
    expect(result.message).toContain('refused lock-held');
    expect(result.message).toContain('"runId":"run-holder"');
    expect(exists(home, `deploy-kit-${lock.lockId(config)}.hold.json`)).toBe(false);
    expect(JSON.parse(readFileSync(join(lockPathFor(config, home), 'owner'), 'utf8')).runId).toBe('run-holder');
    for (const run of [() => ts.clearHold(config, { runtime: runtimeFor(home) }),
      () => ts.setEpoch(config, 1, { runtime: runtimeFor(home) }),
      () => ts.cancelRequest(config, REQUEST_ID, { runtime: runtimeFor(home) })]) {
      expect(run().outcome).toBe('lock-held');
    }
    expect(exists(home, '.last-epoch')).toBe(false);
  });

  // Runs setHold in a child process (the call is synchronous) paused inside the critical section on a
  // shell builtin, so the test can look at the live owner.
  async function paused(config: any, home: string, during: (owner: any, fifo: string) => void) {
    const fifo = join(home, 'pause.fifo');
    execFileSync('mkfifo', [fifo]);
    const code = `
      const ts = require(${JSON.stringify(join(__dirname, '..', 'target-state.js'))});
      const r = ts.setHold(${JSON.stringify(config)}, { reason: 'paused', pauseFifo: ${JSON.stringify(fifo)} });
      console.log(JSON.stringify(r));`;
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, HOME: home, INVOCATION_ID: 'abcdef0123456789abcdef0123456789' } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const done = new Promise<number>((resolve) => child.on('close', (c) => resolve(c as number)));
    for (let i = 0; i < 200 && !existsSync(`${fifo}.ready`); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(`${fifo}.ready`)).toBe(true);
    const owner = JSON.parse(readFileSync(join(lockPathFor(config, home), 'owner'), 'utf8'));
    try {
      during(owner, fifo);
    } finally {
      writeFileSync(fifo, 'go\n');
    }
    expect(await done).toBe(0);
    return JSON.parse(out.trim().split('\n').pop() as string);
  }

  it('owns the lock as a session record while it works, and the lock is held for the whole critical section', async () => {
    const home = freshHome();
    const config = appConfig();
    const result = await paused(config, home, (owner) => {
      expect(owner.kind).toBe('session'); // INVOCATION_ID in the environment does not turn it into a unit
      expect(owner.purpose).toBe('hold-set');
      expect(owner.invocationId).toBeNull();
      expect(owner.pid).toBeGreaterThan(0);
      if (hasProc) {
        expect(owner.sid).toBeGreaterThan(0);
        expect(owner.pstart).toBeGreaterThan(0);
      }
      // held right now: a contender fails fast, and nothing is written yet
      expect(ts.clearHold(config, { runtime: runtimeFor(home) }).outcome).toBe('lock-held');
      expect(exists(home, `deploy-kit-${lock.lockId(config)}.hold.json`)).toBe(false);
    });
    expect(result.outcome).toBe('ok');
    expect(existsSync(lockPathFor(config, home))).toBe(false);
    expect(exists(home, `deploy-kit-${lock.lockId(config)}.hold.json`)).toBe(true);
  });

  it('is a single process: the owner has no child while it holds the lock, and on Linux owns its whole session', async () => {
    const home = freshHome();
    await paused(appConfig(), home, (owner) => {
      const children = spawnSync('pgrep', ['-P', String(owner.pid)], { encoding: 'utf8' });
      expect(children.stdout.trim()).toBe('');
      expect(children.status).toBe(1);
      if (hasProc) {
        const inSession = spawnSync('ps', ['-e', '-o', 'pid=,sid='], { encoding: 'utf8' }).stdout
          .split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, sid]) => sid === owner.sid).map(([pid]) => pid);
        expect(inSession).toEqual([owner.pid]);
        expect(owner.sid).toBe(owner.pid); // setsid made it a session leader
      }
    });
  });
});

describe('classifyJournal', () => {
  const cls = (raw: string | null) => ts.classifyJournal(raw).class;
  it('maps every journal class; a malformed journal is corrupt, not none', () => {
    expect(cls(null)).toBe('none');
    for (const phase of ['done', 'recovered']) expect(cls(JSON.stringify({ phase }))).toBe('terminal');
    for (const phase of ['stopped', 'migrated', 'flipped', 'post-deploy-failed', 'post-deploy-rollback', 'post-deploy-rollback-failed']) {
      expect(cls(JSON.stringify({ phase, releaseId: 'r' }))).toBe('interrupted');
    }
    for (const raw of ['{broken', '', '[]', '"done"', '{}', '{"phase":3}', 'null']) expect(cls(raw), raw).toBe('corrupt');
    expect(ts.classifyJournal('{"phase":"stopped","releaseId":"20261023-abc"}')).toMatchObject({ phase: 'stopped', releaseId: '20261023-abc' });
  });
});

describeWithFlock('target-state (read-only)', () => {
  it('legacy layout: the live sha is HEAD in projectDir, there is no journal, and nothing is created', () => {
    const home = freshHome();
    const projectDir = join(home, 'app');
    const sha = repoWithCommit(projectDir);
    const config = appConfig({ projectDir });
    const state = ts.readTargetState(config, { runtime: runtimeFor(home), now: fixedNow });

    expect(state).toMatchObject({ layout: 'legacy', liveSha: sha, journal: { class: 'none' }, hold: null, lastEpoch: null });
    expect(state.locks).toEqual({ app: { held: false, owner: null } });
    expect(existsSync(dkPath(home, ''))).toBe(false); // read-only: not even the state dir
  });

  it('legacy layout: an unreadable checkout is a problem and a null sha, never a stale value', () => {
    const home = freshHome();
    const state = ts.readTargetState(appConfig({ projectDir: join(home, 'missing') }), { runtime: runtimeFor(home), now: fixedNow });
    expect(state.liveSha).toBeNull();
    expect(state.liveProblem).toMatch(/could not be read/);
  });

  describe('releases layout', () => {
    function releasesApp(home: string) {
      const root = join(home, 'app');
      const sha = repoWithCommit(join(root, 'releases', 'r1'));
      symlinkSync('releases/r1', join(root, 'current'));
      return { config: appConfig({ projectDir: root, layout: { type: 'releases' } }), root, sha };
    }

    it('the live sha is the current release worktree HEAD, with its target', () => {
      const home = freshHome();
      const { config, sha } = releasesApp(home);
      const state = ts.readTargetState(config, { runtime: runtimeFor(home), now: fixedNow });
      expect(state).toMatchObject({ layout: 'releases', liveSha: sha, liveTarget: 'releases/r1', journal: { class: 'none' } });
    });

    it.each([
      ['terminal done', '{"phase":"done","releaseId":"r1"}', 'terminal'],
      ['terminal recovered', '{"phase":"recovered"}', 'terminal'],
      ['interrupted stopped', '{"phase":"stopped","releaseId":"r1"}', 'interrupted'],
      ['interrupted migrated', '{"phase":"migrated","releaseId":"r1"}', 'interrupted'],
      ['corrupt malformed', '{"phase":', 'corrupt'],
      ['corrupt empty file', '', 'corrupt'],
    ])('journal %s', (_name, raw, expected) => {
      const home = freshHome();
      const { config, root } = releasesApp(home);
      writeFileSync(join(root, '.deploy-kit-state.json'), raw);
      expect(ts.readTargetState(config, { runtime: runtimeFor(home), now: fixedNow }).journal.class).toBe(expected);
    });

    it('a dangling current pointer has no sha', () => {
      const home = freshHome();
      const { config, root } = releasesApp(home);
      execFileSync('rm', [join(root, 'current')]);
      symlinkSync('releases/gone', join(root, 'current'));
      const state = ts.readTargetState(config, { runtime: runtimeFor(home), now: fixedNow });
      expect(state.liveSha).toBeNull();
      expect(state.liveTarget).toBe('releases/gone');
    });
  });

  it('reports lastEpoch, the app and host lock owners, and the reservation for --request', () => {
    const home = freshHome();
    mkdirSync(join(home, 'hosts'));
    const config = appConfig({ projectDir: join(home, 'nowhere'), hostLock: { dir: join(home, 'hosts'), key: 'bigpi' } });
    const runtime = runtimeFor(home);
    put(home, '.last-epoch', '12\n');
    lock.acquireLock({ ...config, onHost: { required: true } }, { runtime }, { kind: 'unit', runId: 'host-run', purpose: 'deploy', scope: 'host' });
    holdAppLock(config, home, 'app-run');
    const reservation = { requestId: REQUEST_ID, gen: 1, state: 'accepted', runId: RUN_ID, at: 'x', liveBefore: null, prev: null };
    put(home, `requests/${REQUEST_ID}.json`, reservation);

    const state = ts.readTargetState(config, { requestId: REQUEST_ID, runtime, now: fixedNow });
    expect(state.lastEpoch).toBe(12);
    expect(state.locks.app).toMatchObject({ held: true, owner: { runId: 'app-run', kind: 'unit' } });
    expect(state.locks.host).toMatchObject({ held: true, owner: { runId: 'host-run' } });
    expect(state.reservation).toEqual({ requestId: REQUEST_ID, state: 'valid', record: reservation });

    expect(ts.readTargetState(config, { requestId: 'req-other', runtime, now: fixedNow }).reservation).toEqual({ requestId: 'req-other', state: 'absent' });
    put(home, `requests/${REQUEST_ID}.json`, { ...reservation, gen: 0 });
    expect(ts.readTargetState(config, { requestId: REQUEST_ID, runtime, now: fixedNow }).reservation).toMatchObject({ state: 'corrupt' });
    put(home, '.last-epoch', 'x');
    expect(ts.readTargetState(config, { runtime, now: fixedNow })).toMatchObject({ lastEpoch: null, lastEpochProblem: expect.any(String) });
  });

  it('an unreadable host is an error, not an empty state', () => {
    const runtime = { execFileSync: () => { throw Object.assign(new Error('ssh: connect refused'), { status: 255 }); } };
    expect(() => ts.readTargetState(appConfig({ projectDir: '/x' }), { runtime })).toThrow(/could not read the target state/);
  });
});

describe('cli', () => {
  const run = (args: string[], config = appConfig(), runtime = runtimeFor(freshHome())) => {
    const errors: string[] = [];
    const lines: string[] = [];
    const code = ts.runCommand(args[0], args.slice(1), config, { log: { error: (m: string) => errors.push(m) }, out: (m: string) => lines.push(m), runtime });
    return { code, errors, lines };
  };

  it.skipIf(!hasFlock)('maps outcomes to exit codes: 0 done, 3 refused, 1 lock-held', () => {
    const home = freshHome();
    const config = appConfig();
    const runtime = runtimeFor(home);
    expect(run(['epoch', 'set', '5'], config, runtime)).toMatchObject({ code: 0, lines: ['epoch set 5'] });
    expect(run(['epoch', 'set', '4'], config, runtime).code).toBe(3);
    expect(run(['hold', 'set', '--reason', 'x', '--until', '2030-01-01T00:00:00Z'], config, runtime).code).toBe(0);
    expect(run(['hold', 'clear'], config, runtime).code).toBe(0);
    holdAppLock(config, home);
    expect(run(['hold', 'clear'], config, runtime).code).toBe(1);
    const state = run(['target-state', '--json'], config, runtime);
    expect(state.code).toBe(0);
    expect(JSON.parse(state.lines[0]).locks.app.held).toBe(true);
  });

  it('usage errors exit 1 and never reach the target', () => {
    const throwing = { execFileSync: () => { throw new Error('should not run'); } };
    for (const args of [['hold'], ['hold', 'set'], ['hold', 'set', '--reason'], ['hold', 'clear', 'x'], ['epoch', 'set'], ['epoch', 'bump', '1'],
      ['request', 'cancel'], ['request', 'drop', 'a'], ['target-state'], ['target-state', '--json', 'extra']]) {
      expect(run(args, appConfig(), throwing).code, args.join(' ')).toBe(1);
    }
  });

  it('target-state exits 75 when the host cannot be read', () => {
    const down = { execFileSync: () => { throw Object.assign(new Error('down'), { status: 255 }); } };
    expect(run(['target-state', '--json'], appConfig({ projectDir: '/x' }), down).code).toBe(75);
  });
});

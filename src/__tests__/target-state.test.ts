import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync, spawn, spawnSync } from 'child_process';
import {
  mkdirSync, writeFileSync, existsSync, readdirSync, symlinkSync, statSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { makeTarget, CrashSeam } from './on-host-fixture';
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

describeWithFlock('epoch clear', () => {
  const markerOf = (config: any, kind: 'unresolved' | 'inflight') => `deploy-kit-${lock.lockId(config)}.${kind}.json`;
  const marker = { requestId: REQUEST_ID, runId: RUN_ID, kind: 'deploy', at: 'x' };
  const archives = (home: string) => (exists(home, 'epoch-cleared') ? readdirSync(dkPath(home, 'epoch-cleared')) : []);

  it('removes .last-epoch and archives the old value, the reason and the time', () => {
    const home = freshHome();
    const config = appConfig();
    put(home, '.last-epoch', '7\n');
    const result = ts.clearEpoch(config, 'controller reinstalled "fresh"', { now: fixedNow, runtime: runtimeFor(home) });
    expect(result).toMatchObject({ outcome: 'ok', message: 'epoch cleared (was 7)' });
    expect(exists(home, '.last-epoch')).toBe(false);
    const files = archives(home);
    expect(files).toHaveLength(1);
    expect(readJson(home, `epoch-cleared/${files[0]}`)).toEqual({ epoch: 7, reason: 'controller reinstalled "fresh"', at: fixedNow.toISOString() });
    expect(existsSync(lockPathFor(config, home))).toBe(false);
  });

  it('refuses while an in-flight marker exists, and changes nothing', () => {
    const home = freshHome();
    const config = appConfig();
    put(home, '.last-epoch', '7');
    put(home, markerOf(config, 'inflight'), marker);
    expect(ts.clearEpoch(config, 'r', { runtime: runtimeFor(home) })).toEqual({ outcome: 'refused', message: 'refused epoch-clear inflight' });
    expect(read(home, '.last-epoch')).toBe('7');
    expect(archives(home)).toEqual([]);
  });

  it('refuses while an unresolved marker exists, and changes nothing', () => {
    const home = freshHome();
    const config = appConfig();
    put(home, '.last-epoch', '7');
    put(home, markerOf(config, 'unresolved'), marker);
    expect(ts.clearEpoch(config, 'r', { runtime: runtimeFor(home) })).toEqual({ outcome: 'refused', message: 'refused epoch-clear unresolved' });
    expect(read(home, '.last-epoch')).toBe('7');
    expect(archives(home)).toEqual([]);
  });

  it('refuses lock-held while the app lock is held, and changes nothing', () => {
    const home = freshHome();
    const config = appConfig();
    put(home, '.last-epoch', '7');
    holdAppLock(config, home);
    expect(ts.clearEpoch(config, 'r', { runtime: runtimeFor(home) }).outcome).toBe('lock-held');
    expect(read(home, '.last-epoch')).toBe('7');
    expect(archives(home)).toEqual([]);
  });

  it('with no .last-epoch there is nothing to clear and nothing is archived', () => {
    const home = freshHome();
    expect(ts.clearEpoch(appConfig(), 'r', { runtime: runtimeFor(home) })).toEqual({ outcome: 'ok', message: 'epoch already clear' });
    expect(archives(home)).toEqual([]);
  });

  it('needs a non-empty reason before touching the target', () => {
    expect(() => ts.clearEpoch(appConfig(), ' ', { runtime: runtimeFor(freshHome()) })).toThrow(/reason/);
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

  describe('the live sha follows the physical layout, not the supplied config', () => {
    it('a releases config against an unmigrated legacy host reads HEAD of the checkout', () => {
      const home = freshHome();
      const projectDir = join(home, 'app');
      const sha = repoWithCommit(projectDir);
      const state = ts.readTargetState(appConfig({ projectDir, layout: { type: 'releases' } }), { runtime: runtimeFor(home), now: fixedNow });
      expect(state).toMatchObject({ layout: 'releases', physicalLayout: 'legacy', liveSha: sha });
      expect(state.liveProblem).toBeUndefined();
    });

    it('a legacy config against a migrated host reads the current release', () => {
      const home = freshHome();
      const root = join(home, 'app');
      const sha = repoWithCommit(join(root, 'releases', 'r1'));
      symlinkSync('releases/r1', join(root, 'current'));
      writeFileSync(join(root, '.deploy-kit-layout'), '{"layout":"releases","version":1}');
      const state = ts.readTargetState(appConfig({ projectDir: root }), { runtime: runtimeFor(home), now: fixedNow });
      expect(state).toMatchObject({ layout: 'legacy', physicalLayout: 'releases', liveSha: sha });
    });

    it('an unknown physical layout has a null sha and a problem', () => {
      const home = freshHome();
      const root = join(home, 'app');
      mkdirSync(root);
      const state = ts.readTargetState(appConfig({ projectDir: root }), { runtime: runtimeFor(home), now: fixedNow });
      expect(state).toMatchObject({ physicalLayout: 'unknown', liveSha: null, liveProblem: expect.stringMatching(/physical layout is unknown/) });
    });
  });

  describe('releases layout', () => {
    function releasesApp(home: string) {
      const root = join(home, 'app');
      const sha = repoWithCommit(join(root, 'releases', 'r1'));
      symlinkSync('releases/r1', join(root, 'current'));
      writeFileSync(join(root, '.deploy-kit-layout'), '{"layout":"releases","version":1}');
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

  describe('unresolved / inflight markers', () => {
    const markerFile = (config: any, kind: 'unresolved' | 'inflight') => `deploy-kit-${lock.lockId(config)}.${kind}.json`;
    const marker = { requestId: REQUEST_ID, runId: RUN_ID, kind: 'deploy', at: 'x' };
    const read2 = (home: string, config: any) => ts.readTargetState(config, { runtime: runtimeFor(home), now: fixedNow });
    const corrupt = { present: true, corrupt: true, requestId: null, runId: null, kind: null };

    it.each(['unresolved', 'inflight'] as const)('%s: absent is null', (kind) => {
      const home = freshHome();
      expect(read2(home, appConfig({ projectDir: join(home, 'nowhere') }))[kind]).toBeNull();
    });

    it.each(['unresolved', 'inflight'] as const)('%s: present reports the ids and kind, and the other stays null', (kind) => {
      const home = freshHome();
      const config = appConfig({ projectDir: join(home, 'nowhere') });
      put(home, markerFile(config, kind), { ...marker, status: 'unknown', error: null });
      const state = read2(home, config);
      expect(state[kind]).toEqual({ present: true, requestId: REQUEST_ID, runId: RUN_ID, kind: 'deploy' });
      expect(state[kind === 'inflight' ? 'unresolved' : 'inflight']).toBeNull();
    });

    it.each(['unresolved', 'inflight'] as const)('%s: invalid JSON, or JSON missing requestId, is corrupt, never null', (kind) => {
      const home = freshHome();
      const config = appConfig({ projectDir: join(home, 'nowhere') });
      put(home, markerFile(config, kind), '{not json');
      expect(read2(home, config)[kind]).toEqual(corrupt);
      put(home, markerFile(config, kind), { runId: RUN_ID, kind: 'deploy' });
      expect(read2(home, config)[kind]).toEqual(corrupt);
      put(home, markerFile(config, kind), '[]');
      expect(read2(home, config)[kind]).toEqual(corrupt);
    });

    it('reports the in-flight marker the real accept path wrote', () => {
      const t = makeTarget();
      try {
        const runId = '20261023T095900Z-0123456789ab-deadbeef';
        t.stage(runId);
        expect(() => t.go(runId, { crashAt: 'after-release-result', pipeline: () => undefined })).toThrow(CrashSeam);
        const state = ts.readTargetState(t.config, { runtime: t.runtime, now: fixedNow });
        expect(state.inflight).toEqual({ present: true, requestId: t.readJson(`deploy-kit-${lock.lockId(t.config)}.inflight.json`).requestId, runId, kind: 'deploy' });
        expect(state.unresolved).toBeNull();
      } finally { t.cleanup(); }
    });
  });

  it('an unreadable host is an error, not an empty state', () => {
    const runtime = { execFileSync: () => { throw Object.assign(new Error('ssh: connect refused'), { status: 255 }); } };
    expect(() => ts.readTargetState(appConfig({ projectDir: '/x' }), { runtime })).toThrow(/could not read the target state/);
  });
});

describeWithFlock('target-state capability facts (BRAIN-636)', () => {
  const writeShim = (home: string, name: string, body: string) => {
    const dir = join(home, 'caps-bin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { PATH: `${dir}:${process.env.PATH}` };
  };
  const readWith = (home: string, config: any, env: Record<string, string> = {}) => ts.readTargetState(config, { runtime: runtimeFor(home, env), now: fixedNow });
  const withHostLock = (home: string) => {
    const dir = join(home, 'hosts');
    mkdirSync(dir);
    return appConfig({ projectDir: join(home, 'nowhere'), hostLock: { dir, key: 'bigpi' } });
  };

  it.each([['yes', true], ['no', false]])('linger: loginctl says %s -> %s', (answer, expected) => {
    const home = freshHome();
    const env = writeShim(home, 'loginctl', `echo "Linger=${answer}"`);
    const state = readWith(home, appConfig({ projectDir: join(home, 'nowhere') }), env);
    expect(state.linger).toBe(expected);
    expect(state.lingerProblem).toBeUndefined();
  });

  it('linger: an unreadable answer (loginctl fails, or is missing) is null with a problem, never false or true', () => {
    const home = freshHome();
    const config = appConfig({ projectDir: join(home, 'nowhere') });
    const failing = readWith(home, config, writeShim(home, 'loginctl', 'exit 1'));
    expect(failing).toMatchObject({ linger: null, lingerProblem: expect.stringMatching(/could not be read/) });
    const garbage = readWith(home, config, writeShim(home, 'loginctl', 'echo "Linger=maybe"'));
    expect(garbage.linger).toBeNull();
  });

  it('hostLockDir: null when no hostLock is configured', () => {
    const home = freshHome();
    expect(readWith(home, appConfig({ projectDir: join(home, 'nowhere') })).hostLockDir).toBeNull();
  });

  it('hostLockDir: probes the permanent provisioned parent, idle or held, with the guard file', () => {
    const home = freshHome();
    const config = withHostLock(home);
    const parent = config.hostLock.dir;
    const env = writeShim(home, 'stat', 'echo "deploy 2770"');
    expect(readWith(home, config, env).hostLockDir).toEqual({
      path: parent, group: 'deploy', mode: '2770', writable: true, guard: { exists: false },
    });
    writeFileSync(`${lock.hostLockDir(config)}.guard`, '');
    expect(readWith(home, config, env).hostLockDir).toMatchObject({ writable: true, guard: { exists: true } });
    mkdirSync(lock.hostLockDir(config), { mode: 0o700 }); // held: the transient dir is 0700 and must not be what is reported
    expect(readWith(home, config, env).hostLockDir).toEqual({
      path: parent, group: 'deploy', mode: '2770', writable: true, guard: { exists: true },
    });
    execFileSync('chmod', ['555', parent]);
    try {
      const state = readWith(home, config, env).hostLockDir;
      expect(state).toMatchObject({ path: parent, group: 'deploy', mode: '2770' });
      if (process.getuid && process.getuid() !== 0) expect(state.writable).toBe(false);
    } finally { execFileSync('chmod', ['755', parent]); }
  });

  it('hostLockDir: a missing parent, or a stat that cannot answer, is a problem with the path', () => {
    const home = freshHome();
    const config = withHostLock(home);
    const parent = config.hostLock.dir;
    const env = writeShim(home, 'stat', 'exit 1');
    expect(readWith(home, config, env).hostLockDir).toEqual({ path: parent, problem: expect.stringMatching(/could not be read/) });
    execFileSync('rmdir', [parent]);
    expect(readWith(home, config).hostLockDir).toEqual({ path: parent, problem: expect.stringMatching(/does not exist/) });
  });

  describe('physicalLayout', () => {
    const marker = (root: string, body: string) => writeFileSync(join(root, '.deploy-kit-layout'), body);
    const physical = (home: string, config: any) => readWith(home, config).physicalLayout;

    it('a releases config against an unmigrated legacy host (a git checkout, no marker) reports legacy; layout stays the config', () => {
      const home = freshHome();
      const root = join(home, 'app');
      repoWithCommit(root);
      const config = appConfig({ projectDir: root, layout: { type: 'releases' } });
      expect(physical(home, config)).toBe('legacy');
      expect(readWith(home, config).layout).toBe('releases');
      expect(physical(home, appConfig({ projectDir: root }))).toBe('legacy');
    });

    it('a parsing marker at the right version is releases, whichever config was supplied', () => {
      const home = freshHome();
      const root = join(home, 'app');
      mkdirSync(root);
      marker(root, '{"layout":"releases","version":1}');
      expect(physical(home, appConfig({ projectDir: root }))).toBe('releases');
      expect(physical(home, appConfig({ projectDir: root, layout: { type: 'releases' } }))).toBe('releases');
    });

    it('a marker at another version or unparseable, or neither marker nor checkout, is unknown', () => {
      const home = freshHome();
      const root = join(home, 'app');
      mkdirSync(root);
      const config = appConfig({ projectDir: root });
      expect(physical(home, config)).toBe('unknown');
      marker(root, '{"layout":"releases","version":99}');
      expect(physical(home, config)).toBe('unknown');
      marker(root, '{nope');
      expect(physical(home, config)).toBe('unknown');
    });
  });

  // The framed reply for classifyTargetState, with only the capability records varying.
  const framedWith = (records: Record<string, string | null>) => ({
    framed: {
      records: {
        hold: null, lastEpoch: null, liveSha: null, liveHead: null, unresolved: null, inflight: null, appLock: null, appOwner: null, ...records,
      },
    },
    now: fixedNow,
  });
  const hexLines = (over: Record<string, string> = {}) => Object.entries({
    DK_USER: 'dkapp', DK_UID: '1000', DK_LINGER: 'yes', DK_USER_MANAGER: 'yes', DK_NODE: '/usr/bin/node', DK_NODE_MAJOR: '24', DK_ACTIVE_UNITS: '0',
    DK_SHELL: '/bin/bash', DK_GID: '1000', DK_GROUPS: '1000', DK_GROUP_NAMES: 'dkapp', DK_MANAGER_GROUPS: '1000', DK_UMASK: '0027', DK_OOM: '100',
    DK_PATH: '/usr/bin', DK_HOME: '/srv/dkapp', DK_LOGNAME: 'dkapp', ENV_LANG: 'C', ENVABSENT_PM2_HOME: '1', DK_END: '1', ...over,
  }).map(([k, v]) => `${k}=${Buffer.from(v, 'utf8').toString('hex')}`).join('\n');

  it('preflight: a healthy host is {ok: true, problems: []}; a failing check is reported, not thrown', () => {
    const config = appConfig();
    expect(ts.classifyTargetState(config, framedWith({ preflight: hexLines() })).preflight).toEqual({ ok: true, problems: [] });
    const noLinger = ts.classifyTargetState(config, framedWith({ preflight: hexLines({ DK_LINGER: 'no' }) })).preflight;
    expect(noLinger.ok).toBe(false);
    expect(noLinger.problems).toEqual([expect.stringMatching(/^ONHOST_NO_LINGER:/)]);
  });

  it('preflight: no output, or output that is not the preflight protocol, is a problem', () => {
    const config = appConfig();
    expect(ts.classifyTargetState(config, framedWith({ preflight: null })).preflight).toEqual({ ok: false, problems: [expect.stringMatching(/no output/)] });
    expect(ts.classifyTargetState(config, framedWith({ preflight: 'garbage' })).preflight).toMatchObject({ ok: false, problems: [expect.stringMatching(/^ONHOST_PREFLIGHT:/)] });
  });

  it('preflight: the real script runs on this host and answers with a verdict, whatever tools are missing', () => {
    const home = freshHome();
    const state = readWith(home, appConfig({ projectDir: join(home, 'nowhere') }), writeShim(home, 'loginctl', 'echo Linger=no'));
    expect(state.preflight.ok).toBe(false);
    expect(state.preflight.problems).toHaveLength(1);
  });

  it('proofReadable: present, absent and unreadable evidence', () => {
    const config = appConfig();
    const proof = (records: Record<string, string | null>) => ts.classifyTargetState(config, framedWith(records)).proofReadable;
    expect(proof({ proofCgroup: 'yes', proofSessions: 'yes' })).toEqual({ cgroup: true, procSessions: true });
    expect(proof({ proofCgroup: 'yes', proofSessions: null })).toEqual({ cgroup: true, procSessions: false });
    expect(proof({ proofCgroup: null, proofSessions: 'yes' })).toEqual({ cgroup: false, procSessions: true });
    expect(proof({})).toEqual({ cgroup: false, procSessions: false });
  });

  it('proofReadable: the real probes answer booleans, and false where /proc and the cgroup tree do not exist', () => {
    const home = freshHome();
    const { proofReadable } = readWith(home, appConfig({ projectDir: join(home, 'nowhere') }));
    expect(typeof proofReadable.cgroup).toBe('boolean');
    expect(typeof proofReadable.procSessions).toBe('boolean');
    if (!hasProc) expect(proofReadable).toEqual({ cgroup: false, procSessions: false });
  });

  it('takes no lock and writes nothing: the script has no lock or write step and the host is left as found', () => {
    const home = freshHome();
    const config = withHostLock(home);
    mkdirSync(lock.hostLockDir(config));
    const script = ts.stateReadScript(config);
    expect(script).not.toMatch(/flock|mkdir|\brm\b|\bmv\b|\btouch\b|\bsync\b|setsid/);
    const listing = () => execFileSync('find', [home, '-print'], { encoding: 'utf8' });
    const before = listing();
    readWith(home, config, writeShim(home, 'loginctl', 'echo Linger=yes'));
    const after = listing();
    expect(after.split('\n').filter((l: string) => !l.includes('caps-bin')).join('\n')).toBe(before.split('\n').filter((l: string) => !l.includes('caps-bin')).join('\n'));
    expect(existsSync(dkPath(home, ''))).toBe(false);
    expect(readdirSync(lock.hostLockDir(config))).toEqual([]);
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
    put(home, `deploy-kit-${lock.lockId(config)}.inflight.json`, { requestId: REQUEST_ID, runId: RUN_ID, kind: 'deploy' });
    expect(run(['epoch', 'clear', '--reason', 'x'], config, runtime)).toMatchObject({ code: 3, lines: ['refused epoch-clear inflight'] });
    execFileSync('rm', [dkPath(home, `deploy-kit-${lock.lockId(config)}.inflight.json`)]);
    expect(run(['epoch', 'clear', '--reason', 'x'], config, runtime).code).toBe(0);
    expect(exists(home, '.last-epoch')).toBe(false);
    run(['epoch', 'set', '5'], config, runtime);
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
    for (const args of [['hold'], ['hold', 'set'], ['hold', 'set', '--reason'], ['hold', 'clear', 'x'], ['epoch', 'set'], ['epoch', 'bump', '1'], ['epoch', 'clear'], ['epoch', 'clear', '--reason'], ['epoch', 'clear', 'x'],
      ['request', 'cancel'], ['request', 'drop', 'a'], ['target-state'], ['target-state', '--json', 'extra']]) {
      expect(run(args, appConfig(), throwing).code, args.join(' ')).toBe(1);
    }
  });

  it('target-state exits 75 when the host cannot be read', () => {
    const down = { execFileSync: () => { throw Object.assign(new Error('down'), { status: 255 }); } };
    expect(run(['target-state', '--json'], appConfig({ projectDir: '/x' }), down).code).toBe(75);
  });
});

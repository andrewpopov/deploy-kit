import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import {
  readdirSync, existsSync, readFileSync, writeFileSync, cpSync, mkdtempSync, rmSync, symlinkSync,
} from 'fs';
import { tmpdir } from 'os';
import { execFileSync, spawn, spawnSync } from 'child_process';
import { join } from 'path';
import {
  hasFlock, hasProc, freshHome, runtimeFor, appConfig, put, read, readJson, exists, dkPath, lockPathFor, holdAppLock,
  cleanupHomes, nodeShim, REQUEST_ID, RUN_ID, OTHER_RUN_ID,
} from './target-state-fixture';

const require = createRequire(__filename);
const ts = require('../target-state.js');
const { readRecord, validateReservation } = require('../on-host/status.js');

const describeWithFlock = process.platform === 'win32' || !hasFlock ? describe.skip : describe;
afterEach(cleanupHomes);

const NOW = new Date('2026-10-23T12:00:00Z');
const RES_FILE = `requests/${REQUEST_ID}.json`;
const reservation = (over: Record<string, unknown> = {}) => ({
  requestId: REQUEST_ID, gen: 1, state: 'accepted', runId: RUN_ID, at: '2026-10-23T10:30:00Z', liveBefore: 'a'.repeat(40), prev: null, ...over,
});
const terminal = (runId: string, result: Record<string, unknown>) => ({
  runId, kind: 'deploy', result, effects: [{ step: 'fetch', class: 'staging' }], kitArtifact: { version: '0.33.0', sha256: 'b'.repeat(64) }, finishedAt: '2026-10-23T10:40:00Z',
});
// A DeployResult that passes validateDeployResult; `over` changes only what a case is about.
const deployResult = (over: Record<string, unknown> = {}) => ({
  status: 'aborted-clean', stage: 'disruptive-gate', liveBefore: 'a'.repeat(40), liveAfter: null, migrated: false, migrationsPending: null,
  backupId: null, effectsClean: true, recovery: { action: 'none', verified: true }, error: null, ...over,
});
const cleanAbort = deployResult();

function setup() {
  const home = freshHome();
  const config = appConfig();
  const runtime = runtimeFor(home);
  const cancel = () => ts.cancelRequest(config, REQUEST_ID, { now: NOW, runtime });
  return { home, config, runtime, cancel };
}
// The tombstone must satisfy the D5 status reader exactly.
const tombstoneProblem = (home: string) => readRecord(read(home, RES_FILE), validateReservation, REQUEST_ID);

describeWithFlock('request cancel: no reservation file', () => {
  it('writes gen 1 as a valid cancelled record when nothing names the request', () => {
    const { home, config, cancel } = setup();
    const result = cancel();

    expect(result).toEqual({ outcome: 'ok', message: `cancelled ${REQUEST_ID} gen=1` });
    expect(readJson(home, RES_FILE)).toEqual({
      requestId: REQUEST_ID, gen: 1, state: 'cancelled', runId: null, at: NOW.toISOString(), liveBefore: null, prev: null,
    });
    expect(tombstoneProblem(home).state).toBe('valid');
    expect(existsSync(lockPathFor(config, home))).toBe(false);
    expect(readdirSync(dkPath(home, 'requests')).filter((n) => n.includes('.tmp.'))).toEqual([]);
  });

  it('is cancellable when a run names the request but never accepted, or when an accepted run names another request', () => {
    const { home, cancel } = setup();
    put(home, `runs/${RUN_ID}/meta.json`, { requestId: REQUEST_ID, kind: 'deploy' }); // staged/claimed/refused only
    put(home, `runs/${OTHER_RUN_ID}/meta.json`, { requestId: 'req-other', parentRequestId: REQUEST_ID });
    put(home, `runs/${OTHER_RUN_ID}/accepted.json`, { runId: OTHER_RUN_ID });
    expect(cancel().outcome).toBe('ok');
  });

  it('refuses reservation-missing when a run with accepted.json names the request, even pretty-printed', () => {
    const { home, cancel } = setup();
    put(home, `runs/${RUN_ID}/meta.json`, JSON.stringify({ kind: 'deploy', requestId: REQUEST_ID }, null, 2));
    put(home, `runs/${RUN_ID}/accepted.json`, { runId: RUN_ID });
    const result = cancel();
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^not-cancellable reservation-missing/);
    expect(exists(home, RES_FILE)).toBe(false);
  });
});

describeWithFlock('request cancel: reservation held by a run', () => {
  it('cancels (gen+1, prev = the run) when it ended aborted-clean with effectsClean true', () => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation({ gen: 3 }));
    put(home, `runs/${RUN_ID}/terminal.json`, terminal(RUN_ID, cleanAbort));

    expect(cancel()).toEqual({ outcome: 'ok', message: `cancelled ${REQUEST_ID} gen=4` });
    expect(readJson(home, RES_FILE)).toEqual({
      requestId: REQUEST_ID, gen: 4, state: 'cancelled', runId: null, at: NOW.toISOString(), liveBefore: null, prev: { runId: RUN_ID, gen: 3 },
    });
    expect(tombstoneProblem(home).state).toBe('valid');
  });

  it('reads pretty-printed JSON and a prev from an earlier clean abort', () => {
    const { home, cancel } = setup();
    put(home, RES_FILE, JSON.stringify(reservation({ gen: 2, prev: { gen: 1, runId: OTHER_RUN_ID } }), null, 2));
    put(home, `runs/${RUN_ID}/terminal.json`, JSON.stringify(terminal(RUN_ID, cleanAbort), null, 2));
    expect(cancel().outcome).toBe('ok');
    expect(readJson(home, RES_FILE)).toMatchObject({ gen: 3, prev: { runId: RUN_ID, gen: 2 } });
  });

  it('accepted-not-clean: aborted-clean with effectsClean false is request-executed, file untouched', () => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation());
    put(home, `runs/${RUN_ID}/terminal.json`, terminal(RUN_ID, deployResult({ effectsClean: false })));
    const before = read(home, RES_FILE);
    const result = cancel();
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^not-cancellable request-executed/);
    expect(read(home, RES_FILE)).toBe(before);
  });

  it.each([
    ['deployed', deployResult({ status: 'deployed', effectsClean: true })],
    ['failed', deployResult({ status: 'failed', effectsClean: false })],
    ['failed-recovered', deployResult({ status: 'failed-recovered', effectsClean: true })],
  ])('a run that ended %s is request-executed', (_name, result) => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation());
    put(home, `runs/${RUN_ID}/terminal.json`, terminal(RUN_ID, result));
    expect(cancel().message).toMatch(/^not-cancellable request-executed/);
  });

  it('a run with no terminal.json (running, or killed) is request-taken', () => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation());
    put(home, `runs/${RUN_ID}/accepted.json`, { runId: RUN_ID });
    const result = cancel();
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^not-cancellable request-taken/);
  });

  it.each([
    ['malformed', '{"runId":'],
    ['another run id', JSON.stringify(terminal(OTHER_RUN_ID, cleanAbort))],
    ['no result object', JSON.stringify({ runId: RUN_ID, kind: 'deploy', result: 'aborted-clean', finishedAt: 'x' })],
    ['unknown kind', JSON.stringify({ ...terminal(RUN_ID, cleanAbort), kind: 'launch' })],
    ['braces but missing result fields', '{"runId":"' + RUN_ID + '","kind":"deploy","finishedAt":"x","result":{"status":"aborted-clean","effectsClean":true}}'],
    ['the expected fragments inside invalid JSON', '{"runId":"' + RUN_ID + '","kind":"deploy","finishedAt":"x","result":{"status":"aborted-clean","effectsClean":true},}'],
  ])('a corrupt terminal.json (%s) never reads as a clean abort', (_name, raw) => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation());
    put(home, `runs/${RUN_ID}/terminal.json`, raw);
    expect(cancel().message).toMatch(/^not-cancellable terminal-corrupt/);
  });

  it('aborted-clean and effectsClean true appearing only inside a nested unrelated object do not authorize a cancel', () => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation());
    put(home, `runs/${RUN_ID}/terminal.json`, {
      ...terminal(RUN_ID, deployResult({ status: 'failed', effectsClean: false })), notes: { status: 'aborted-clean', effectsClean: true },
    });
    const before = read(home, RES_FILE);
    expect(cancel().message).toMatch(/^not-cancellable request-executed/);
    expect(read(home, RES_FILE)).toBe(before);
  });

  it('an already cancelled reservation is confirmed idempotently and not rewritten', () => {
    const { home, cancel } = setup();
    put(home, RES_FILE, reservation({ state: 'cancelled', runId: null, gen: 2, liveBefore: null }));
    const before = read(home, RES_FILE);
    expect(cancel()).toEqual({ outcome: 'ok', message: `cancelled ${REQUEST_ID} gen=2 (already)` });
    expect(read(home, RES_FILE)).toBe(before);
  });
});

describeWithFlock('request cancel: unreadable accepted-run metadata', () => {
  it('fails closed (not-cancellable corrupt) when meta.json beside an accepted.json cannot be parsed, with no reservation', () => {
    const { home, cancel } = setup();
    put(home, `runs/${RUN_ID}/meta.json`, '{"requestId":"' + REQUEST_ID); // truncated
    put(home, `runs/${RUN_ID}/accepted.json`, { runId: RUN_ID });
    const result = cancel();
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^not-cancellable corrupt\n/);
    expect(exists(home, RES_FILE)).toBe(false);
  });

  it('fails closed when meta.json is missing beside an accepted.json', () => {
    const { home, cancel } = setup();
    put(home, `runs/${RUN_ID}/accepted.json`, { runId: RUN_ID });
    expect(cancel().message).toMatch(/^not-cancellable corrupt/);
    expect(exists(home, RES_FILE)).toBe(false);
  });
});

describeWithFlock('request cancel: corrupt reservation', () => {
  it.each([
    ['not json', 'garbage'],
    ['truncated', '{"requestId":"req-deploy'],
    ['an array', '[]'],
    ['empty file', ''],
    ['another request id', JSON.stringify(reservation({ requestId: 'req-other' }))],
    ['gen 0', JSON.stringify(reservation({ gen: 0 }))],
    ['gen as a string', JSON.stringify(reservation({ gen: '1' }))],
    ['unknown state', JSON.stringify(reservation({ state: 'held' }))],
    ['accepted without a runId', JSON.stringify(reservation({ runId: null }))],
    ['runId not a run id', JSON.stringify(reservation({ runId: 'run-1' }))],
    ['no at', JSON.stringify(reservation({ at: '' }))],
    ['liveBefore a number', JSON.stringify(reservation({ liveBefore: 5 }))],
    ['prev missing fields', JSON.stringify(reservation({ prev: { runId: RUN_ID } }))],
    ['prev an empty object', JSON.stringify(reservation({ prev: {} }))],
    ['prev a string', JSON.stringify(reservation({ prev: 'x' }))],
  ])('%s is not-cancellable corrupt, agreeing with the D5 reader, and is not touched', (_name, raw) => {
    const { home, cancel } = setup();
    put(home, RES_FILE, raw);
    put(home, `runs/${RUN_ID}/terminal.json`, terminal(RUN_ID, cleanAbort)); // would be cancellable if the file were valid
    const result = cancel();

    expect(readRecord(raw, validateReservation, REQUEST_ID).state).toBe('corrupt');
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^not-cancellable corrupt\n/);
    expect(read(home, RES_FILE)).toBe(raw);
  });
});

describeWithFlock('request cancel: the target has no copy of the builder\'s kit', () => {
  // The script is built from a throwaway copy of the kit and that copy is deleted just before the script
  // runs, as in production where the controller's kit path does not exist on the host.
  function cancelWithBuilderKitGone(prepare: (home: string) => void) {
    const { home, config, runtime } = setup();
    prepare(home);
    const kit = mkdtempSync(join(tmpdir(), 'deploy-kit-builder-'));
    cpSync(join(__dirname, '..'), join(kit, 'src'), { recursive: true });
    cpSync(join(__dirname, '..', '..', 'package.json'), join(kit, 'package.json'));
    symlinkSync(join(__dirname, '..', '..', 'node_modules'), join(kit, 'node_modules'));
    const builder = createRequire(join(kit, 'x.js'))('./src/target-state.js');
    const gone = {
      execFileSync: (...args: unknown[]) => {
        rmSync(kit, { recursive: true, force: true });
        return (runtime.execFileSync as (...a: unknown[]) => string)(...args);
      },
    };
    const result = builder.cancelRequest(config, REQUEST_ID, { now: NOW, runtime: gone });
    expect(existsSync(kit)).toBe(false);
    return { home, result };
  }

  it('still cancels a valid clean abort', () => {
    const { home, result } = cancelWithBuilderKitGone((h) => {
      put(h, RES_FILE, reservation({ gen: 3 }));
      put(h, `runs/${RUN_ID}/terminal.json`, terminal(RUN_ID, cleanAbort));
    });
    expect(result).toEqual({ outcome: 'ok', message: `cancelled ${REQUEST_ID} gen=4` });
    expect(readJson(home, RES_FILE).state).toBe('cancelled');
  });

  it('still refuses a corrupt terminal.json', () => {
    const { home, result } = cancelWithBuilderKitGone((h) => {
      put(h, RES_FILE, reservation());
      put(h, `runs/${RUN_ID}/terminal.json`, '{"runId":"' + RUN_ID + '","kind":"deploy","finishedAt":"x","result":{"status":"aborted-clean","effectsClean":true}}');
    });
    expect(result.outcome).toBe('refused');
    expect(result.message).toMatch(/^not-cancellable terminal-corrupt/);
    expect(readJson(home, RES_FILE).state).toBe('accepted');
  });
});

describeWithFlock('request cancel: the lock session', () => {
  it('holds exactly the owner while paused, then only the owner and its waited-for node child while validating, and nothing after release', async () => {
    const home = freshHome();
    const config = appConfig();
    const fifo = join(home, 'pause.fifo');
    execFileSync('mkfifo', [fifo]);
    const shim = nodeShim(home, join(lockPathFor(config, home), 'owner'));
    put(home, RES_FILE, reservation());
    put(home, `runs/${RUN_ID}/terminal.json`, terminal(RUN_ID, cleanAbort));
    const code = `
      const ts = require(${JSON.stringify(join(__dirname, '..', 'target-state.js'))});
      console.log(JSON.stringify(ts.cancelRequest(${JSON.stringify(config)}, ${JSON.stringify(REQUEST_ID)}, { pauseFifo: ${JSON.stringify(fifo)} })));`;
    const child = spawn(process.execPath, ['-e', code], { env: { ...process.env, ...shim.env, HOME: home } });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    const done = new Promise<number>((resolve) => child.on('close', (c) => resolve(c as number)));
    for (let i = 0; i < 200 && !existsSync(`${fifo}.ready`); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(`${fifo}.ready`)).toBe(true);
    const owner = JSON.parse(readFileSync(join(lockPathFor(config, home), 'owner'), 'utf8'));
    try {
      expect(spawnSync('pgrep', ['-P', String(owner.pid)], { encoding: 'utf8' }).stdout.trim()).toBe(''); // before validation: no child
      expect(existsSync(shim.log)).toBe(false);
    } finally {
      writeFileSync(fifo, 'go\n');
    }
    expect(await done).toBe(0);
    expect(JSON.parse(out.trim().split('\n').pop() as string).outcome).toBe('ok');

    const lines = readFileSync(shim.log, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1); // node ran exactly once
    const [, ppid, sid, ownerRecord] = /^(\d+) (\d*) (.*)$/.exec(lines[0]) as RegExpExecArray;
    expect(Number(ppid)).toBe(owner.pid); // a direct, waited-for child of the owner, started synchronously
    if (hasProc) {
      expect(Number(sid)).toBe(owner.sid); // same session: it did not start one
      const left = spawnSync('ps', ['-e', '-o', 'pid=,sid='], { encoding: 'utf8' }).stdout
        .split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, s]) => s === owner.sid);
      expect(left).toEqual([]); // nothing in the session after release
    }
    expect(ownerRecord).toContain('"kind":"session"');
    expect(existsSync(lockPathFor(config, home))).toBe(false);
  });
});

describeWithFlock('request cancel: locking and the command line', () => {
  it('fails fast with lock-held and writes nothing when the app lock is taken', () => {
    const { home, config, cancel } = setup();
    holdAppLock(config, home);
    const result = cancel();
    expect(result.outcome).toBe('lock-held');
    expect(result.message).toContain('refused lock-held');
    expect(exists(home, RES_FILE)).toBe(false);
  });

  it('rejects a bad request id before touching the target', () => {
    const { config, runtime } = setup();
    for (const bad of ['', 'a b', 'a/b', "x';rm -rf /", '$(id)']) {
      expect(() => ts.cancelRequest(config, bad, { runtime }), bad).toThrow(/request id/);
    }
  });

  it('exits 3 and prints not-cancellable <reason> through the CLI; 0 on success', () => {
    const { home, config, runtime } = setup();
    const lines: string[] = [];
    const cli = (id: string) => ts.runCommand('request', ['cancel', id], config, { log: { error: () => {} }, out: (m: string) => lines.push(m), runtime, now: NOW });
    put(home, `requests/${REQUEST_ID}.json`, 'garbage');
    expect(cli(REQUEST_ID)).toBe(3);
    expect(lines.join('\n')).toMatch(/^not-cancellable corrupt/);
    expect(cli('req-fresh')).toBe(0);
    expect(readJson(home, 'requests/req-fresh.json').state).toBe('cancelled');
  });
});

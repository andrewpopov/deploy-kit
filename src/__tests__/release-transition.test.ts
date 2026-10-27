import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';
import { makeFakeFs, nodeEScript, runScriptOnFake } from './durable-storage-fixture';

const require = createRequire(__filename);
const kit = require('../index.js');
const release = require('../release.js');
const { createTransitionOperationManager } = require('../transition-operation.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'b'.repeat(40);
const STATE_FILE = '.deploy-kit-state.json';
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const RUNTIME_TAGS = ['pre-hook', 'install', 'build', 'stop', 'backup', 'migrate', 'flip', 'check', 'restore', 'restart'];

// Rollback hosts: two releases whose full SHAs share no prefix, so a 12-char or dir-name inference cannot pass.
const ORIG_DIR = 'releases/00000000aaaa-20260709T090000Z';
const PREV_DIR = 'releases/00000000bbbb-20260708T090000Z';
const ORIG_FULL = `0123456789ab${'c'.repeat(28)}`;
const PREV_FULL = `fedcba987654${'d'.repeat(28)}`;
const CAND_DIR = 'releases/a1b2c3d4e5f6-20260710T090000Z'; // the forward candidate (fixed `date -u` timestamp), full SHA = SHA
const SHA_OF: Record<string, string> = { [ORIG_DIR]: ORIG_FULL, [PREV_DIR]: PREV_FULL, [CAND_DIR]: SHA };

// What execFileSync throws for a failed command: the child's stdout is still attached to the error.
const execFailure = (stdout: string) => Object.assign(new Error('Command failed'), { stdout, status: 1 });

interface RollbackOpts {
  restartCommand?: string;
  flipFails?: (relTarget: string, dest: string) => boolean; checkFails?: boolean; headFails?: (relDir: string) => boolean;
  probeSha?: (call: number) => string | undefined; // override the running-SHA answer for one probe call
}

// Observable host state (forward candidate and manual rollback alike): release SHA map, current/previous
// pointers, the running process pointer and whether PM2 reports the apps online.
function makeRollbackHost(opts: RollbackOpts = {}) {
  const s: {
    current: string; previous: string; running: string; online: boolean; flips: string[]; previousFlips: string[]; restarts: number;
    headReads: Array<{ dir: string; sha: string }>; probeCalls: number;
  } = {
    current: ORIG_DIR, previous: PREV_DIR, running: ORIG_DIR, online: true,
    flips: [], previousFlips: [], restarts: 0, headReads: [], probeCalls: 0,
  };
  const handle = (full: string): string | undefined => {
    const [, cwd = '', cmd = full] = /^cd (\S+) && ([\s\S]*)$/.exec(full) ?? [];
    const head = cmd === 'git rev-parse HEAD' ? /^\/srv\/app\/(releases\/\S+)$/.exec(cwd) : null;
    if (head) {
      const sha = SHA_OF[head[1]];
      s.headReads.push({ dir: head[1], sha });
      if (opts.headFails?.(head[1])) throw execFailure(sha);
      return `${sha}\n`;
    }
    const flip = /^ln -s (\S+) \S+ && mv -Tf \S+ (\S+)$/.exec(cmd);
    if (flip) {
      const isCurrent = flip[2].endsWith('/current');
      (isCurrent ? s.flips : s.previousFlips).push(flip[1]);
      if (opts.flipFails?.(flip[1], flip[2])) throw execFailure('');
      if (isCurrent) s.current = flip[1]; else s.previous = flip[1];
      return '';
    }
    if (cmd.includes('pre-restart-smoke')) { if (opts.checkFails) throw execFailure(''); return ''; }
    if (/pm2 stop /.test(cmd)) { s.online = false; return ''; }
    if (/pm2 startOrRestart/.test(cmd) || (opts.restartCommand && cmd.includes(opts.restartCommand))) { s.restarts += 1; s.running = s.current; s.online = true; return ''; }
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: s.online ? 'online' : 'stopped', restart_time: 5 } }]);
    if (cmd.startsWith('readlink /srv/app/current')) return s.current;
    if (cmd.startsWith('readlink /srv/app/previous')) return s.previous;
    if (/^readlink -f \/srv\/app\/releases\//.test(cmd)) return cmd.slice('readlink -f '.length);
    if (cmd.includes('readlink -f /proc/111/cwd')) return `/srv/app/${s.running}`;
    if (cmd.includes('get-running-sha')) { s.probeCalls += 1; return opts.probeSha?.(s.probeCalls) ?? SHA_OF[s.running]; }
    return undefined;
  };
  return { s, handle };
}

interface Journal { operations: Array<{ operationId: string; state: string; beginDigest: string; beginJson: string }> }
interface Phase { phase: string; operationId?: string; targetSha?: string }
type StateRead = 'normal' | 'corrupt' | 'empty' | 'fails';

// Durable authority operation storage, carried across invocations; records every write as an event.
function makeStorage(events: string[]) {
  const store: { text: string | null; writes: number } = { text: null, writes: 0 };
  return {
    store,
    storage: {
      read() { return store.text === null ? null : JSON.parse(store.text); },
      write(json: string) {
        store.writes += 1;
        store.text = json;
        const ops: Journal['operations'] = JSON.parse(json).operations;
        events.push(`storage:${ops[ops.length - 1].state}`);
        return { status: 'written' };
      },
    },
  };
}

// Fake authority transport recording exact request bytes; the digest is computed from those bytes.
function makeAuthority(events: string[], fails: (action: string, count: number) => boolean = () => false, after: (action: string, count: number) => void = () => {}) {
  const requests: string[] = [];
  const actions: string[] = [];
  const terminal: Record<string, string> = { begin: 'AUTHORIZED', complete: 'COMPLETED', abandon: 'ABANDONED' };
  return {
    requests, actions,
    send(request: Record<string, unknown>) {
      const bytes = JSON.stringify(request);
      const action = String(request.action);
      requests.push(bytes);
      actions.push(action);
      events.push(`send:${action}`);
      const count = actions.filter((a) => a === action).length;
      if (fails(action, count)) throw new Error('timeout');
      after(action, count);
      return { planned: false, operationId: request.operationId, requestDigest: sha256(bytes), receipt: 'receipt-1', state: terminal[action] };
    },
  };
}

// Content-aware target: answers the real preflight/lock/git/pm2 commands and keeps the phase journal the
// way the host would, by running the real fsync-backed phase storage script over a fake fs.
function makeTarget(events: string[], over: { builtSha?: string; stateRead?: StateRead; stateSeed?: Record<string, unknown>; phaseFault?: (phase: Phase) => string | undefined; shaProbe?: (call: number) => string; headFails?: boolean; rb?: ReturnType<typeof makeRollbackHost>; onCommand?: (cmd: string) => void } = {}) {
  const t: { stateText: string | null; lastDeploy: string | null; shaCalls: number; stopped: boolean; stateWrites: string[]; deliveries: string[] } = { stateText: null, lastDeploy: null, shaCalls: 0, stopped: false, stateWrites: [], deliveries: [] };
  const seed = { fails: undefined, corrupt: Buffer.from('{not json'), empty: Buffer.alloc(0), normal: undefined }[over.stateRead ?? 'normal'];
  const phaseFs = makeFakeFs(STATE_FILE, {
    existing: over.stateSeed ? Buffer.from(JSON.stringify(over.stateSeed)) : seed,
    readCode: over.stateRead === 'fails' ? 'EACCES' : undefined,
  });
  const tags: Array<[RegExp, string]> = [
    [/pre-hook/, 'pre-hook'], [/npm ci/, 'install'], [/npm run build/, 'build'], [/pm2 stop/, 'stop'],
    [/run-backup/, 'backup'], [/run-migrate/, 'migrate'], [/mv -Tf/, 'flip'], [/pm2 (startOrRestart|start|restart)|guarded-activate-runtime/, 'restart'],
    [/pre-restart-smoke/, 'check'], [/run-restore/, 'restore'],
  ];
  const execFileSync = (_file: string, args: string[], options?: { input?: string }) => {
    const cmd = args[args.length - 1];
    const tag = tags.find(([re]) => re.test(cmd));
    if (tag) events.push(`target:${tag[1]}`);
    if (cmd.includes('deliver-hook')) t.deliveries.push(String(options?.input));
    // Protected phase record: the REAL static storage script, decoded from the shell-quoted command, over a fake fs.
    const script = nodeEScript(cmd);
    if (script?.includes(STATE_FILE)) {
      const input = String(options?.input);
      const body = input.slice(input.indexOf('\n') + 1);
      const isWrite = input.startsWith('write\n');
      if (isWrite) phaseFs.setFail(over.phaseFault?.(JSON.parse(body)));
      try {
        const stdout = runScriptOnFake(script, phaseFs, input);
        if (isWrite) {
          const phase: Phase = JSON.parse(body);
          t.stateWrites.push(body);
          events.push(`target:state:${phase.phase}`);
        }
        return stdout;
      } finally {
        t.stateText = phaseFs.files.get(STATE_FILE)?.toString() ?? null;
      }
    }
    over.onCommand?.(cmd);
    const modelled = over.rb?.handle(cmd);
    if (modelled !== undefined) return modelled;
    if (over.headFails && cmd.startsWith('cd /srv/app/releases/') && cmd.endsWith('git rev-parse HEAD')) throw execFailure(over.builtSha ?? SHA);
    if (cmd.includes('.deploy-kit-last-deploy.json.tmp')) { t.lastDeploy = cmd; events.push('target:last-deploy'); return ''; }
    if (cmd.includes('/.deploy-kit-state.json.tmp')) {
      const match = /printf '%s' '(.*?)' > /.exec(cmd);
      if (!match) throw new Error('unrecognised unfenced journal write');
      const body = match[1];
      JSON.parse(body);
      t.stateText = body; t.stateWrites.push(body);
      return '';
    }
    if (cmd.includes(STATE_FILE) && cmd.includes('cat ')) return t.stateText || '';
    if (cmd.includes(STATE_FILE)) throw new Error(`unrecognised phase journal command: ${cmd}`);
    if (/pm2 stop /.test(cmd)) { t.stopped = true; return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { t.stopped = false; return ''; }
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('rev-parse HEAD')) return over.builtSha ?? SHA;
    if (cmd.includes('rev-parse')) return SHA;
    if (cmd.includes('readlink -f')) return '/srv/app/releases/a1b2c3d4e5f6-20260710T090000Z';
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: t.stopped ? 'stopped' : 'online', restart_time: 5 } }]);
    if (cmd.includes('readlink ') && cmd.includes('/current')) return 'releases/00000000aaaa-20260709T090000Z';
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return 'releases/00000000bbbb-20260708T090000Z';
    if (cmd.includes('ls -1')) return 'a1b2c3d4e5f6-20260710T090000Z\n00000000aaaa-20260709T090000Z\n00000000bbbb-20260708T090000Z';
    if (cmd.includes('get-running-sha')) { t.shaCalls += 1; return over.shaProbe ? over.shaProbe(t.shaCalls) : SHA; }
    if (cmd.includes('run-backup')) return '/var/lib/backups/app-20260710T090000Z.db.gpg';
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { t, execFileSync, phaseFs };
}

interface ConfigOver {
  preRestartChecks?: Array<{ name: string; command: string }>; layout?: Record<string, unknown>;
  postDeployChecks?: Array<{ name: string; command: string; onFailure: string }>; deliveryEvent?: boolean;
  hooks?: Record<string, string>;
}
const relConfig = (over: ConfigOver = {}) => mergeConfig(DEFAULT_CONFIG, {
  ...(over.preRestartChecks ? { preRestartChecks: over.preRestartChecks } : {}),
  ...(over.postDeployChecks ? { postDeployChecks: over.postDeployChecks } : {}),
  ...(over.deliveryEvent ? { deliveryEvent: { command: 'deliver-hook' } } : {}),
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 },
  hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore', ...over.hooks },
  preDeployChecks: [{ name: 'pre', command: 'pre-hook' }],
  layout: { type: 'releases', keepReleases: 4, sharedPaths: [], releaseChecks: [], runningShaCommand: 'get-running-sha', ...over.layout },
  transitionAuthority: { command: 'authority', scope: 'host-a' },
});

// One host: durable storage + journal state survive across invocations, as the real host's files would.
function makeHost(opts: { authorityFails?: (action: string, count: number) => boolean; afterSend?: (action: string, count: number) => void; config?: ConfigOver } = {}) {
  const events: string[] = [];
  const durable = makeStorage(events);
  const authority = makeAuthority(events, opts.authorityFails, opts.afterSend);
  let uuids = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`;
  const ctxFor = (target: ReturnType<typeof makeTarget>) => ({
    runtime: { execFileSync: target.execFileSync },
    sleep: () => {},
    now: () => Date.parse('2026-07-10T09:00:00Z'),
    transitionManagerFactory: (cfg: unknown, c: Record<string, unknown>) => createTransitionOperationManager(
      cfg, { ...c, storage: durable.storage, send: authority.send, uuid },
    ),
  });
  const deploy = (target: ReturnType<typeof makeTarget>) => release.deployRelease(relConfig(opts.config), {}, ctxFor(target));
  const rollback = (target: ReturnType<typeof makeTarget>) => release.rollbackRelease(relConfig(opts.config), {}, ctxFor(target));
  const journal = (): Journal => JSON.parse(String(durable.store.text));
  const runtimeEvents = (from = 0) => events.slice(from).filter((e) => RUNTIME_TAGS.map((tag) => `target:${tag}`).includes(e));
  return { events, durable, authority, deploy, rollback, journal, runtimeEvents };
}
const phaseOf = (target: ReturnType<typeof makeTarget>): Phase => JSON.parse(String(target.t.stateText));
const at = (events: string[], event: string) => {
  const i = events.indexOf(event);
  expect(i, `${event} missing from ${events.join(',')}`).toBeGreaterThanOrEqual(0);
  return i;
};

describe('protected forward release completion', () => {
  it('PREFENCE_BEFORE_CONFIGURED_HOOKS: begin ACK + MUTATING precede every hook; success only after the complete ACK', () => {
    const host = makeHost();
    const target = makeTarget(host.events);
    const result = host.deploy(target);
    expect(result.healthy).toBe(true);
    const { events } = host;
    const mutating = at(events, 'storage:MUTATING');
    expect(at(events, 'storage:AUTHORIZED')).toBeLessThan(mutating);
    expect(at(events, 'send:begin')).toBeLessThan(at(events, 'storage:AUTHORIZED'));
    for (const tag of ['pre-hook', 'install', 'build', 'stop', 'flip', 'restart']) {
      expect(mutating, tag).toBeLessThan(at(events, `target:${tag}`));
    }
    const completed = at(events, 'storage:COMPLETED');
    expect(at(events, 'send:complete')).toBeLessThan(completed);
    expect(completed).toBeLessThan(at(events, 'target:state:done'));
    expect(at(events, 'target:state:done')).toBeLessThan(at(events, 'target:last-deploy'));
    // Producer/consumer independence: the id and digest come from the request bytes the transport saw.
    const begin = JSON.parse(host.authority.requests[0]);
    const op = host.journal().operations[0];
    expect(op.beginDigest).toBe(sha256(host.authority.requests[0]));
    expect(phaseOf(target)).toMatchObject({ phase: 'done', operationId: begin.operationId, targetSha: SHA });
    const record = /printf '%s' '(.*?)' > /.exec(String(target.t.lastDeploy));
    expect(JSON.parse(record ? record[1] : 'null')).toMatchObject({ sha: SHA, layout: 'release' });
  });

  it('FINAL_VERIFY_FAILURE_RETRY_REFUSED: failed final verify abandons UNKNOWN and the retry refuses before any begin/hook', () => {
    const host = makeHost();
    const target = makeTarget(host.events, { shaProbe: (call) => (call === 1 ? SHA : OTHER_SHA) });
    expect(() => host.deploy(target)).toThrow(/abandoned UNKNOWN/);
    expect(host.authority.actions).toEqual(['begin', 'abandon']);
    expect(JSON.parse(host.authority.requests[1])).toMatchObject({ action: 'abandon', reason: 'UNKNOWN' });
    expect(host.journal().operations[0].state).toBe('ABANDONED');
    const begin = JSON.parse(host.authority.requests[0]);
    expect(phaseOf(target)).toMatchObject({ operationId: begin.operationId, targetSha: SHA });
    expect(['done', 'recovered']).not.toContain(phaseOf(target).phase);
    expect(target.t.lastDeploy).toBeNull();

    const mark = host.events.length;
    const writes = host.durable.store.writes;
    expect(() => host.deploy(target)).toThrow(/requires recovery under transition authority/);
    expect(host.authority.actions).toEqual(['begin', 'abandon']);
    expect(host.durable.store.writes).toBe(writes);
    expect(host.runtimeEvents(mark)).toEqual([]);
    expect(host.events.slice(mark).filter((e) => e.startsWith('target:state:'))).toEqual([]);
  });

  it('COMPLETE_ACK_LOST_NO_RECOVERY: lost complete ACK leaves the op pending; retry only reconciles that exact request', () => {
    const host = makeHost({ authorityFails: (action, count) => action === 'complete' && count === 1 });
    const target = makeTarget(host.events);
    expect(() => host.deploy(target)).toThrow(/outcome is uncertain/);
    expect(host.authority.actions).toEqual(['begin', 'complete']);
    expect(host.journal().operations[0].state).toBe('COMPLETE_PENDING');
    expect(['done', 'recovered']).not.toContain(phaseOf(target).phase);
    expect(phaseOf(target).operationId).toBe(host.journal().operations[0].operationId);
    expect(target.t.lastDeploy).toBeNull();

    const mark = host.events.length;
    expect(() => host.deploy(target)).toThrow(/pending transition RPC reconciled/);
    expect(host.authority.actions).toEqual(['begin', 'complete', 'complete']);
    expect(host.authority.requests[2]).toBe(host.authority.requests[1]);
    expect(host.journal().operations).toHaveLength(1);
    expect(host.journal().operations[0].state).toBe('COMPLETED');
    expect(host.runtimeEvents(mark)).toEqual([]);
    expect(target.t.lastDeploy).toBeNull();
  });

  it('BEGIN_REFUSAL_ZERO_RUNTIME: a failed authority begin runs no configured hook or runtime effect', () => {
    const host = makeHost({ authorityFails: (action) => action === 'begin' });
    const target = makeTarget(host.events);
    expect(() => host.deploy(target)).toThrow(/begin outcome is uncertain/);
    expect(host.authority.actions).toEqual(['begin']);
    expect(host.runtimeEvents()).toEqual([]);
    expect(target.t.stateWrites).toEqual([]);
  });

  it('CANDIDATE_SHA_MISMATCH_ZERO_BEGIN: worktree HEAD differing from the resolved SHA never reaches begin', () => {
    const host = makeHost();
    const target = makeTarget(host.events, { builtSha: OTHER_SHA });
    expect(() => host.deploy(target)).toThrow(/Candidate SHA/);
    expect(host.authority.actions).toEqual([]);
    expect(host.durable.store.writes).toBe(0);
    expect(host.runtimeEvents()).toEqual([]);
  });

  it.each<StateRead>(['fails', 'corrupt', 'empty'])('PHASE_JOURNAL_READ_FAILURE_ZERO_BEGIN: %s phase journal fails closed', (stateRead) => {
    const host = makeHost();
    const target = makeTarget(host.events, { stateRead });
    expect(() => host.deploy(target)).toThrow(/deploy state journal/);
    expect(host.authority.actions).toEqual([]);
    expect(host.durable.store.writes).toBe(0);
    expect(host.runtimeEvents()).toEqual([]);
  });

  const badProbeCases: Array<[string, () => string, boolean]> = [
    ['shared 12-char prefix, wrong suffix', () => `${SHA.slice(0, 12)}${'0'.repeat(28)}`, false],
    ['truncated 12-char output', () => SHA.slice(0, 12), false],
    ['matching full SHA but exit 1', () => SHA, true],
  ];
  it.each(badProbeCases)('PROTECTED_RUNNING_SHA_EXACT: %s cannot complete a forward release', (_name, bad, exits) => {
    const host = makeHost();
    const target = makeTarget(host.events, {
      shaProbe: (call) => {
        if (call === 1) return SHA;
        if (exits) throw execFailure(bad());
        return bad();
      },
    });
    expect(() => host.deploy(target)).toThrow(/abandoned UNKNOWN/);
    expect(host.authority.actions).toEqual(['begin', 'abandon']);
    expect(JSON.parse(host.authority.requests[1])).toMatchObject({ reason: 'UNKNOWN' });
    expect(target.t.shaCalls).toBeLessThanOrEqual(3); // first probe + one per health attempt
    expect(target.t.lastDeploy).toBeNull();
  });

  it('PROTECTED_HEAD_PROBE_SUCCESS_REQUIRED: a failing candidate HEAD read with matching stdout never reaches forward begin', () => {
    const host = makeHost();
    const target = makeTarget(host.events, { headFails: true });
    expect(() => host.deploy(target)).toThrow(/Candidate SHA read failed/);
    expect(host.authority.actions).toEqual([]);
    expect(host.durable.store.writes).toBe(0);
    expect(host.runtimeEvents()).not.toContain('target:flip');
    expect(host.runtimeEvents()).not.toContain('target:restart');
  });

  it('MISSING_RUNNING_SHA_COMMAND_ZERO_BEGIN: forward and rollback refuse before any begin', () => {
    const host = makeHost({ config: { layout: { runningShaCommand: '' } } });
    expect(() => host.deploy(makeTarget(host.events))).toThrow(/running SHA command/);
    expect(() => host.rollback(makeTarget(host.events, { rb: makeRollbackHost() }))).toThrow(/running SHA command/);
    expect(host.authority.actions).toEqual([]);
    expect(host.durable.store.writes).toBe(0);
  });
});

describe('protected forward automatic recovery', () => {
  const failing = (...patterns: string[]) => (cmd: string) => { if (patterns.some((p) => cmd.includes(p))) throw execFailure(''); };
  const forward = (opts: Parameters<typeof makeHost>[0] = {}, rbOpts: RollbackOpts = {}, onCommand?: (cmd: string) => void) => {
    const host = makeHost(opts);
    const rb = makeRollbackHost(rbOpts);
    return { host, rb, target: makeTarget(host.events, { rb, onCommand }) };
  };
  const requestsOf = (host: ReturnType<typeof makeHost>) => host.authority.requests.map((r) => JSON.parse(r));
  const phases = (target: ReturnType<typeof makeTarget>) => target.t.stateWrites.map((w) => (JSON.parse(w) as Phase).phase);
  const fence = (events: string[]) => events.filter((e) => /^(send:|storage:MUTATING|target:(flip|check|restore|restart))/.test(e));
  const withCheck: ConfigOver = { preRestartChecks: [{ name: 'smoke', command: 'pre-restart-smoke' }] };

  it('SAFE_PHASE_FRESH_CHILD: an unconfirmed stop (stop-only window) abandons UNKNOWN, then a fresh fenced child resumes the original SHA', () => {
    const { host, rb, target } = forward({}, {}, failing('pm2 stop'));
    expect(() => host.deploy(target)).toThrow(/recovered/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'complete']);
    const [deploy, abandon, recovery, complete] = requestsOf(host);
    expect(deploy).toMatchObject({ kind: 'deploy', targetSha: SHA, targetRelease: CAND_DIR, priorPointer: ORIG_DIR });
    expect(abandon).toMatchObject({ operationId: deploy.operationId, reason: 'UNKNOWN' });
    expect(recovery).toMatchObject({ kind: 'automatic-recovery', parentOperationId: deploy.operationId, targetSha: ORIG_FULL, targetRelease: ORIG_DIR, priorPointer: ORIG_DIR });
    expect(recovery.operationId).not.toBe(deploy.operationId);
    expect(complete.operationId).toBe(recovery.operationId);
    expect(host.authority.requests[3]).toContain(ORIG_FULL);
    expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'COMPLETED']);
    expect(fence(host.events)).toEqual(['send:begin', 'storage:MUTATING', 'send:abandon', 'send:begin', 'storage:MUTATING', 'target:restart', 'send:complete']);
    expect(phases(target).slice(phases(target).indexOf('stopped'))).toEqual(['stopped', 'forward-recovery', 'recovered']);
    expect(phaseOf(target)).toMatchObject({ phase: 'recovered', operationId: recovery.operationId, targetSha: ORIG_FULL, sha: ORIG_FULL });
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true, restarts: 1, probeCalls: 1 });
    expect(target.t.lastDeploy).toBeNull();
  });

  it('ABANDON_REFUSAL_ZERO_RECOVERY: an unacknowledged forward abandon starts no recovery and keeps the pending journal', () => {
    const { host, rb, target } = forward({ authorityFails: (action) => action === 'abandon' }, {}, failing('pm2 stop'));
    expect(() => host.deploy(target)).toThrow(/abandon was not acknowledged/);
    expect(host.authority.actions).toEqual(['begin', 'abandon']);
    expect(host.journal().operations).toHaveLength(1);
    expect(['ABANDONED', 'COMPLETED']).not.toContain(host.journal().operations[0].state);
    expect(phaseOf(target).phase).toBe('stopped');
    expect(host.runtimeEvents()).not.toContain('target:restart');
    expect(host.runtimeEvents()).not.toContain('target:restore');
    expect(rb.s).toMatchObject({ restarts: 0, online: true }); // the stop never took
  });

  it.each<[string, Record<string, string>, string]>([
    ['BACKUP_HOOK_FAILURE_MANUAL', {}, 'run-backup'],
    ['PENDING_PROBE_FAILURE_MANUAL', { pendingMigrations: 'count-pending' }, 'count-pending'],
  ])('%s: a failed hook in hook-running abandons the parent UNKNOWN only; no resume, restore or new begin', (_name, hooks, failingCommand) => {
    const { host, rb, target } = forward({ config: { hooks } }, {}, failing(failingCommand));
    expect(() => host.deploy(target)).toThrow(/manual recovery assessment required/);
    expect(host.authority.actions).toEqual(['begin', 'abandon']);
    expect(requestsOf(host)[1]).toMatchObject({ reason: 'UNKNOWN' });
    expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED']);
    expect(phaseOf(target).phase).toBe('hook-running');
    for (const tag of ['restart', 'restore', 'flip', 'migrate']) expect(host.runtimeEvents()).not.toContain(`target:${tag}`);
    expect(rb.s).toMatchObject({ restarts: 0, online: false, current: ORIG_DIR });
    expect(target.t.lastDeploy).toBeNull();
  });

  it('PHASE_DURABILITY_UNCERTAIN_ZERO_RECOVERY: a phase write failing before stop keeps the op MUTATING and runs nothing further', () => {
    for (const step of ['fsync-file', 'fsync-dir']) {
      const host = makeHost();
      const rb = makeRollbackHost();
      const target = makeTarget(host.events, { rb, phaseFault: (p) => (p.phase === 'stopped' ? step : undefined) });
      let thrown: unknown;
      try { host.deploy(target); } catch (e) { thrown = e; }
      const codes = thrown instanceof Error ? [Reflect.get(thrown, 'code'), Reflect.get(Object(thrown.cause), 'code')] : [];
      expect(codes, step).toContain('JOURNAL_FAILED');
      expect(host.authority.actions, step).toEqual(['begin']);
      expect(host.journal().operations.map((o) => o.state), step).toEqual(['MUTATING']);
      expect(host.runtimeEvents(), step).not.toContain('target:stop');
      expect(host.runtimeEvents(), step).not.toContain('target:restart');
      expect(rb.s, step).toMatchObject({ restarts: 0, online: true });
      expect(target.t.lastDeploy, step).toBeNull();
      // The NEXT invocation assesses what actually became durable. A failed file fsync left no valid phase
      // record (manual); a failed parent fsync can leave the renamed, valid versioned stopped record (recovery).
      const mark = host.events.length;
      if (step === 'fsync-file') {
        expect(() => host.deploy(target), step).toThrow(/recovery assessment/);
        expect(host.authority.actions, step).toEqual(['begin']);
        expect(host.runtimeEvents(mark), step).toEqual([]);
      } else {
        expect(() => host.deploy(target), step).toThrow(/recovered/);
        expect(host.authority.actions, step).toEqual(['begin', 'abandon', 'begin', 'complete']);
        expect(host.runtimeEvents(mark), step).toEqual(['target:restart']);
      }
    }
  });

  describe('interrupted stop recovery (real producer: phase fsync fault after pm2 stop)', () => {
    const interrupted = (hostOpts: Parameters<typeof makeHost>[0] = {}) => {
      const host = makeHost(hostOpts);
      const rbOpts: RollbackOpts = {};
      const rb = makeRollbackHost(rbOpts);
      let fault: (p: Phase) => string | undefined = (p) => (p.phase === 'hook-running' && !rb.s.online ? 'fsync-file' : undefined);
      let onCmd: (cmd: string) => void = () => {};
      const target = makeTarget(host.events, { rb, phaseFault: (p) => fault(p), onCommand: (cmd) => onCmd(cmd) });
      let thrown: unknown;
      try { host.deploy(target); } catch (e) { thrown = e; }
      const codes = thrown instanceof Error ? [Reflect.get(thrown, 'code'), Reflect.get(Object(thrown.cause), 'code')] : [];
      expect(codes).toContain('JOURNAL_FAILED');
      expect(host.authority.actions).toEqual(['begin']);
      expect(host.journal().operations.map((o) => o.state)).toEqual(['MUTATING']);
      expect(host.runtimeEvents()).toContain('target:stop');
      for (const tag of ['backup', 'migrate', 'flip', 'restart']) expect(host.runtimeEvents()).not.toContain(`target:${tag}`);
      expect(rb.s).toMatchObject({ online: false, restarts: 0, current: ORIG_DIR });
      const getPhase = (): Record<string, unknown> => JSON.parse(String(target.phaseFs.files.get(STATE_FILE)));
      const setPhase = (p: Record<string, unknown>) => { target.phaseFs.files.set(STATE_FILE, Buffer.from(JSON.stringify(p))); };
      expect(getPhase()).toMatchObject({ phase: 'stopped', operationId: host.journal().operations[0].operationId, targetSha: SHA });
      fault = () => undefined;
      return { host, rb, rbOpts, target, getPhase, setPhase, setFault: (f: typeof fault) => { fault = f; }, setOnCmd: (f: typeof onCmd) => { onCmd = f; }, mark: host.events.length };
    };
    const reqs = (host: ReturnType<typeof makeHost>) => host.authority.requests.map((r) => JSON.parse(r));

    it('INTERRUPTED_STOP_FRESH_CHILD_ENDS: the retry abandons the old op, runs a fenced child at the previous release and ends the invocation', () => {
      const { host, rb, target, getPhase, setPhase, mark } = interrupted();
      const oldStopped = getPhase();
      const oldId = host.journal().operations[0].operationId;
      expect(() => host.deploy(target)).toThrow(/recovered.*start a new invocation/);
      expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'complete']);
      const [, abandon, child, complete] = reqs(host);
      expect(abandon).toMatchObject({ operationId: oldId, reason: 'UNKNOWN' });
      expect(child).toMatchObject({ kind: 'interrupted-recovery', parentOperationId: oldId, targetSha: ORIG_FULL, targetRelease: ORIG_DIR, priorPointer: ORIG_DIR });
      expect(complete.operationId).toBe(child.operationId);
      expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'COMPLETED']);
      expect(host.events.slice(mark).filter((e) => /^(send:|storage:MUTATING|target:)/.test(e)))
        .toEqual(['send:abandon', 'send:begin', 'storage:MUTATING', 'target:state:interrupted-recovery', 'target:restart', 'send:complete', 'target:state:recovered']);
      expect(phases(target).slice(-2)).toEqual(['interrupted-recovery', 'recovered']);
      expect(getPhase()).toMatchObject({ phase: 'recovered', operationId: child.operationId, targetSha: ORIG_FULL, sha: ORIG_FULL });
      expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true, restarts: 1, probeCalls: 2 });
      expect(target.t.lastDeploy).toBeNull();
      // Replaying the old stopped record after recovery completed is denied: no remote authority mutation.
      setPhase(oldStopped);
      expect(() => host.deploy(target)).toThrow(/requires recovery under transition authority/);
      expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'complete']);
      expect(rb.s.restarts).toBe(1);
    });

    type Ctx = ReturnType<typeof interrupted>;
    const mutate = (k: string, v: unknown) => (x: Ctx) => { const p = x.getPhase(); if (v === undefined) delete p[k]; else p[k] = v; x.setPhase(p); };
    it.each<[string, (x: Ctx) => void]>([
      ['phase version missing', mutate('phaseJournalVersion', undefined)],
      ['layout version wrong', mutate('layoutVersion', 2)],
      ['operationId', mutate('operationId', '00000000-0000-4000-8000-0000000000ff')],
      ['targetSha', mutate('targetSha', OTHER_SHA)],
      ['sha', mutate('sha', OTHER_SHA)],
      ['releaseId', mutate('releaseId', '0000b2c3d4e5-20260710T090000Z')],
      ['prevTarget', mutate('prevTarget', PREV_DIR)],
      ['phase migrated', mutate('phase', 'migrated')],
      ['migrated flag', mutate('migrated', true)],
      ['flipped flag', mutate('flipped', true)],
      ['current readlink exits nonzero with valid stdout', (x) => x.setOnCmd((cmd) => { if (/(?:^|&& )readlink \/srv\/app\/current(?:\s|$)/.test(cmd)) throw execFailure(ORIG_DIR); })],
      ['previous HEAD read exits nonzero with full SHA', (x) => { x.rbOpts.headFails = (dir) => dir === ORIG_DIR; }],
    ])('INTERRUPTED_BINDING_REFUSAL: %s refuses with zero new authority or runtime effect', (_name, corrupt) => {
      const x = interrupted();
      corrupt(x);
      const journalBefore = x.host.durable.store.text;
      expect(() => x.host.deploy(x.target)).toThrow();
      expect(x.host.authority.actions).toEqual(['begin']);
      expect(x.host.durable.store.text).toBe(journalBefore);
      expect(x.host.runtimeEvents(x.mark)).toEqual([]);
      expect(x.rb.s).toMatchObject({ restarts: 0, online: false });
    });

    it('INTERRUPTED_BINDING_REFUSAL: manual rollback on a matching stopped record has zero effects', () => {
      const x = interrupted();
      const journalBefore = x.host.durable.store.text;
      expect(() => x.host.rollback(x.target)).toThrow(/MUTATING operation requires recovery assessment/);
      expect(x.host.authority.actions).toEqual(['begin']);
      expect(x.host.durable.store.text).toBe(journalBefore);
      expect(x.host.runtimeEvents(x.mark)).toEqual([]);
      expect(x.rb.s).toMatchObject({ restarts: 0, online: false, flips: [] });
    });

    it.each<[string, string, string[], string, number]>([
      ['abandon refused', 'abandon', ['begin', 'abandon'], 'ABANDON_PENDING', 0],
      ['child begin refused', 'begin', ['begin', 'abandon', 'begin'], 'BEGIN_PENDING', 0],
      ['complete ACK lost', 'complete', ['begin', 'abandon', 'begin', 'complete'], 'COMPLETE_PENDING', 1],
    ])('INTERRUPTED_ACK_UNCERTAINTY: %s leaves the pending state with no further mutation', (_name, failAction, actions, state, restarts) => {
      const x = interrupted({ authorityFails: (action, count) => action === failAction && (action !== 'begin' || count === 2) });
      expect(() => x.host.deploy(x.target)).toThrow();
      expect(x.host.authority.actions).toEqual(actions);
      const ops = x.host.journal().operations;
      expect(ops[ops.length - 1].state).toBe(state);
      expect(x.rb.s.restarts).toBe(restarts);
      expect(x.getPhase().phase).not.toBe('recovered');
    });

    it('INTERRUPTED_PHASE_WRITE_UNCERTAINTY: a child phase fsync failure keeps the child MUTATING and starts nothing further', () => {
      const x = interrupted();
      x.setFault((p) => (p.phase === 'interrupted-recovery' ? 'fsync-file' : undefined));
      expect(() => x.host.deploy(x.target)).toThrow();
      expect(x.host.authority.actions).toEqual(['begin', 'abandon', 'begin']);
      expect(x.host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'MUTATING']);
      expect(x.rb.s.restarts).toBe(0);
      x.setFault(() => undefined);
      expect(() => x.host.deploy(x.target)).toThrow(/recovery assessment/);
      expect(x.host.authority.actions).toEqual(['begin', 'abandon', 'begin']);
      expect(x.rb.s.restarts).toBe(0);
    });
  });

  it.each([
    ['unversioned done', { phase: 'done', layoutVersion: 1 }],
    ['unversioned stopped', { phase: 'stopped', layoutVersion: 1 }],
  ])('LEGACY_PHASE_RECORD_REFUSED: %s is denied before any begin or hook', (_name, stateSeed) => {
    const host = makeHost();
    const target = makeTarget(host.events, { stateSeed });
    expect(() => host.deploy(target)).toThrow(/not a versioned protected phase journal/);
    expect(host.authority.actions).toEqual([]);
    expect(host.runtimeEvents()).toEqual([]);
    expect(target.t.stateWrites).toEqual([]);
  });

  it.each(['done', 'recovered'])('VERSIONED_TERMINAL_ALLOWED: a versioned %s record at the current layout lets a new deploy begin', (phase) => {
    const host = makeHost();
    const target = makeTarget(host.events, { stateSeed: { phase, phaseJournalVersion: 1, layoutVersion: release.LAYOUT_VERSION } });
    expect(host.deploy(target).healthy).toBe(true);
    expect(host.authority.actions).toEqual(['begin', 'complete']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['wrong phase version', { phase: 'done', phaseJournalVersion: 2, layoutVersion: 1 }],
    ['wrong layout version', { phase: 'done', phaseJournalVersion: 1, layoutVersion: 2 }],
  ])('LEGACY_PHASE_RECORD_REFUSED: %s is denied', (_name, stateSeed) => {
    const host = makeHost();
    expect(() => host.deploy(makeTarget(host.events, { stateSeed }))).toThrow(/not a versioned protected phase journal/);
    expect(host.authority.actions).toEqual([]);
  });

  it.each<[string, RollbackOpts, string[]]>([
    ['restore failure', {}, ['run-restore']],
    ['flip-back failure', { flipFails: (rel, dest) => rel === ORIG_DIR && dest.endsWith('/current') }, []],
  ])('RESTORE_OR_FLIP_FAILURE_NO_RESTART: %s after migrate+flip abandons the recovery UNKNOWN and never restarts PM2', (name, rbOpts, failCommands) => {
    const { host, rb, target } = forward({ config: withCheck }, { ...rbOpts, checkFails: true }, failing(...failCommands));
    expect(() => host.deploy(target)).toThrow(/abandoned UNKNOWN/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon']);
    const [deploy, , recovery, abandon] = requestsOf(host);
    expect(recovery).toMatchObject({ kind: 'automatic-recovery', parentOperationId: deploy.operationId, targetSha: ORIG_FULL });
    expect(abandon).toMatchObject({ operationId: recovery.operationId, reason: 'UNKNOWN' });
    expect(host.runtimeEvents()).not.toContain('target:restart');
    // The ordinary previous-pointer metadata flip (dest previous) succeeded; only the current flip-back may fail.
    expect(rb.s).toMatchObject({ restarts: 0, online: false, previous: ORIG_DIR, previousFlips: [ORIG_DIR], flips: [CAND_DIR, ORIG_DIR] });
    expect(rb.s.current, name).toBe(failCommands.length ? ORIG_DIR : CAND_DIR);
    expect(host.events.includes('target:restore')).toBe(true);
  });

  it('RESTART_SETTLES_PARENT: a crash after the first recovery settles makes the restart child re-check actual state and start again', () => {
    const rb = makeRollbackHost({ probeSha: (call) => (call <= 4 ? OTHER_SHA : undefined) }); // forward verify + first resume lie
    const host = makeHost({ afterSend: (action, count) => { if (action === 'abandon' && count === 2) rb.s.online = false; } });
    const target = makeTarget(host.events, { rb });
    expect(() => host.deploy(target)).toThrow(/recovered/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon', 'begin', 'complete']);
    const [deploy, , first, firstAbandon, restart, complete] = requestsOf(host);
    expect(first).toMatchObject({ kind: 'automatic-recovery', parentOperationId: deploy.operationId, targetSha: ORIG_FULL });
    expect(firstAbandon).toMatchObject({ operationId: first.operationId, reason: 'UNKNOWN' });
    expect(restart).toMatchObject({ kind: 'recovery-restart', parentOperationId: first.operationId, targetSha: ORIG_FULL, targetRelease: ORIG_DIR });
    expect(new Set([deploy.operationId, first.operationId, restart.operationId]).size).toBe(3);
    expect(complete.operationId).toBe(restart.operationId);
    expect(host.authority.requests[5]).toContain(ORIG_FULL);
    expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'ABANDONED', 'COMPLETED']);
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true, restarts: 3 }); // forward, first resume, restart child
    expect(phaseOf(target)).toMatchObject({ phase: 'recovered', operationId: restart.operationId, targetSha: ORIG_FULL });
    expect(target.t.lastDeploy).toBeNull();
  });

  it.each([['remain-active', 'degraded', 'post-deploy-degraded', 'remained-active'], ['manual', 'failed', 'post-deploy-manual-decision', 'manual-decision-required']])(
    'FAILED_POLICY_NEVER_COMPLETE: %s leaves the candidate active under a fenced report child that abandons FAILED',
    (policy, status, phase, outcome) => {
      const postDeployChecks = [{ name: 'smoke-post', command: 'post-check-fail', onFailure: policy }];
      const { host, target } = forward({ config: { postDeployChecks, deliveryEvent: true } }, {}, failing('post-check-fail'));
      expect(() => host.deploy(target)).toThrow(/manual review required/);
      expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon']);
      const [deploy, , report, abandon] = requestsOf(host);
      expect(report).toMatchObject({ kind: 'automatic-recovery', parentOperationId: deploy.operationId, targetSha: SHA, targetRelease: CAND_DIR });
      expect(abandon).toMatchObject({ operationId: report.operationId, reason: 'FAILED' });
      expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'ABANDONED']);
      expect(target.t.deliveries.map((d) => JSON.parse(d))).toMatchObject([{ status, failedCheck: 'smoke-post', activeRelease: CAND_DIR, recovery: { policy, outcome, verified: false } }]);
      expect(phaseOf(target)).toMatchObject({ phase, operationId: report.operationId, targetSha: SHA });
      expect(target.t.lastDeploy).toBeNull();
    },
  );

  it('FINALIZATION_ERROR_NO_RECOVER: a lost recovery complete ACK stays COMPLETE_PENDING with no further abandon, begin or restart', () => {
    const { host, rb, target } = forward({ authorityFails: (action) => action === 'complete' }, {}, failing('pm2 stop'));
    expect(() => host.deploy(target)).toThrow(/outcome is uncertain/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'complete']);
    expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'COMPLETE_PENDING']);
    expect(phaseOf(target).phase).toBe('forward-recovery');
    expect(rb.s.restarts).toBe(1);
  });

  it('DIAGNOSTIC_EVENT_NOT_FINAL_VERIFICATION: a delivery hook that takes the apps offline cannot yield a verified or complete recovery', () => {
    const rb = makeRollbackHost();
    const host = makeHost({ config: { postDeployChecks: [{ name: 'smoke-post', command: 'post-check-fail', onFailure: 'rollback' }], deliveryEvent: true } });
    const target = makeTarget(host.events, { rb, onCommand: (cmd) => {
      if (cmd.includes('post-check-fail')) throw execFailure('');
      if (cmd.includes('deliver-hook')) rb.s.online = false;
    } });
    expect(() => host.deploy(target)).toThrow(/recovery did not verify/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon']);
    expect(requestsOf(host)[3]).toMatchObject({ reason: 'FAILED' });
    const payloads = target.t.deliveries.map((d) => JSON.parse(d));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ status: 'failed', recovery: { outcome: 'rolled-back', verified: false } });
    expect(phaseOf(target)).toMatchObject({ phase: 'post-deploy-rollback-failed', recoveryOutcome: 'rollback-failed-not-started' });
    expect(rb.s).toMatchObject({ online: false, restarts: 2 });
    expect(target.t.lastDeploy).toBeNull();
  });
});

describe('protected manual rollback', () => {
  const withCheck: ConfigOver = { preRestartChecks: [{ name: 'smoke', command: 'pre-restart-smoke' }] };
  const setup = (opts: Parameters<typeof makeHost>[0] = {}, rbOpts: RollbackOpts = {}) => {
    const host = makeHost(opts);
    const rb = makeRollbackHost(rbOpts);
    return { host, rb, target: makeTarget(host.events, { rb }) };
  };
  const fenceEvents = (events: string[]) => events.filter((e) => /^(send:|storage:MUTATING|target:(flip|check|restore|restart))/.test(e));

  it('MANUAL_PREFENCE_BEFORE_EFFECTS: begin + MUTATING precede flip/check/restart; healthy only after the exact observation completes', () => {
    const { host, rb, target } = setup({ config: withCheck });
    const result = host.rollback(target);
    expect(result).toMatchObject({ release: PREV_DIR, healthy: true });
    expect(fenceEvents(host.events)).toEqual(['send:begin', 'storage:MUTATING', 'target:flip', 'target:check', 'target:restart', 'send:complete']);
    expect(at(host.events, 'send:complete')).toBeLessThan(at(host.events, 'storage:COMPLETED'));
    expect(at(host.events, 'storage:COMPLETED')).toBeLessThan(at(host.events, 'target:state:done'));

    const begin = JSON.parse(host.authority.requests[0]);
    expect(begin).toMatchObject({ kind: 'manual-rollback', targetSha: PREV_FULL, targetRelease: PREV_DIR, priorPointer: ORIG_DIR, parentOperationId: null });
    expect(begin.targetSha).not.toBe(ORIG_FULL);
    expect(host.journal().operations).toHaveLength(1);
    expect(host.journal().operations[0].beginDigest).toBe(sha256(host.authority.requests[0]));
    expect(host.authority.requests[1]).toContain(PREV_FULL);
    expect(host.authority.requests[1]).not.toContain(ORIG_FULL);
    expect(phaseOf(target)).toMatchObject({ phase: 'done', operationId: begin.operationId, targetSha: PREV_FULL, sha: PREV_FULL });
    // Mapped SHAs, pointers and the activated process come from the host, not the request.
    expect(rb.s.headReads).toEqual([{ dir: PREV_DIR, sha: PREV_FULL }]);
    expect(rb.s).toMatchObject({ current: PREV_DIR, running: PREV_DIR, flips: [PREV_DIR], restarts: 1 });
    expect(SHA_OF[rb.s.running]).toBe(PREV_FULL);
  });

  it('FAILED_MANUAL_RECOVERY_FRESH_CHILD: failed pre-restart check abandons UNKNOWN, then a fresh automatic-recovery child restores the original SHA', () => {
    const { host, rb, target } = setup({ config: withCheck }, { checkFails: true });
    expect(() => host.rollback(target)).toThrow(/Rollback aborted/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'complete']);
    const [manual, abandon, recovery, complete] = host.authority.requests.map((r) => JSON.parse(r));
    expect(manual).toMatchObject({ kind: 'manual-rollback', targetSha: PREV_FULL });
    expect(abandon).toMatchObject({ operationId: manual.operationId, reason: 'UNKNOWN' });
    expect(recovery).toMatchObject({
      kind: 'automatic-recovery', parentOperationId: manual.operationId, targetSha: ORIG_FULL, targetRelease: ORIG_DIR, priorPointer: PREV_DIR,
    });
    expect(recovery.operationId).not.toBe(manual.operationId);
    expect(complete.operationId).toBe(recovery.operationId);
    expect(host.journal().operations.map((o) => o.state)).toEqual(['ABANDONED', 'COMPLETED']);
    expect(phaseOf(target)).toMatchObject({ phase: 'recovered', operationId: recovery.operationId, targetSha: ORIG_FULL, sha: ORIG_FULL });
    expect(fenceEvents(host.events)).toEqual([
      'send:begin', 'storage:MUTATING', 'target:flip', 'target:check', 'send:abandon',
      'send:begin', 'storage:MUTATING', 'target:flip', 'target:restart', 'send:complete',
    ]);
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, flips: [PREV_DIR, ORIG_DIR], restarts: 1 });
    expect(rb.s.headReads).toEqual([{ dir: PREV_DIR, sha: PREV_FULL }, { dir: ORIG_DIR, sha: ORIG_FULL }]);
  });

  it('RECOVERY_BEGIN_REFUSAL_NO_FLIPBACK: a refused recovery begin leaves no flip-back, restart or DB restore', () => {
    const { host, rb, target } = setup({ config: withCheck, authorityFails: (action, count) => action === 'begin' && count === 2 }, { checkFails: true });
    expect(() => host.rollback(target)).toThrow(/begin outcome is uncertain/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin']);
    expect(host.runtimeEvents()).toEqual(['target:flip', 'target:check']);
    expect(rb.s).toMatchObject({ current: PREV_DIR, flips: [PREV_DIR], restarts: 0 });
  });

  it('RECOVERY_FLIP_FAILURE_NO_RESTART: a failed flip-back abandons the recovery UNKNOWN and never restarts PM2', () => {
    const { host, rb, target } = setup({ config: withCheck }, { checkFails: true, flipFails: (rel) => rel === ORIG_DIR });
    expect(() => host.rollback(target)).toThrow(/recovery failed and was abandoned UNKNOWN/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon']);
    const requests = host.authority.requests.map((r) => JSON.parse(r));
    expect(requests[3]).toMatchObject({ operationId: requests[2].operationId, reason: 'UNKNOWN' });
    expect(host.runtimeEvents()).toEqual(['target:flip', 'target:check', 'target:flip']);
    expect(rb.s).toMatchObject({ current: PREV_DIR, flips: [PREV_DIR, ORIG_DIR], restarts: 0 });
  });

  it('MANUAL_COMPLETE_ACK_LOST_NO_RECOVERY: a lost complete ACK keeps the pending journal and starts no recovery', () => {
    const { host, rb, target } = setup({ authorityFails: (action, count) => action === 'complete' && count === 1 });
    expect(() => host.rollback(target)).toThrow(/outcome is uncertain/);
    expect(host.authority.actions).toEqual(['begin', 'complete']);
    expect(host.journal().operations).toHaveLength(1);
    expect(host.journal().operations[0].state).toBe('COMPLETE_PENDING');
    expect(phaseOf(target).operationId).toBe(host.journal().operations[0].operationId);
    expect(['done', 'recovered']).not.toContain(phaseOf(target).phase);
    expect(host.runtimeEvents()).toEqual(['target:flip', 'target:restart']);
    expect(rb.s.flips).toEqual([PREV_DIR]);
  });

  it('PROTECTED_HEAD_PROBE_SUCCESS_REQUIRED: a failing previous HEAD read with matching stdout never reaches manual begin', () => {
    const { host, rb, target } = setup({}, { headFails: (dir) => dir === PREV_DIR });
    expect(() => host.rollback(target)).toThrow(/previous .* SHA read failed/);
    expect(rb.s.headReads).toEqual([{ dir: PREV_DIR, sha: PREV_FULL }]);
    expect(host.authority.actions).toEqual([]);
    expect(host.durable.store.writes).toBe(0);
    expect(host.runtimeEvents()).toEqual([]);
  });
});

describe('PKG-272 fenced custom activation', () => {
  const hook = 'guarded-activate-runtime';

  it('RESTART_FENCED_RECOVERY runs the override only inside the fresh authorized recovery child', () => {
    const host = makeHost({ config: { hooks: { restart: hook } } });
    const rb = makeRollbackHost({ restartCommand: hook });
    const calls: string[] = [];
    const target = makeTarget(host.events, { rb, onCommand: command => {
      calls.push(command);
      if (command.includes('pm2 stop')) throw execFailure('');
    } });
    expect(() => host.deploy(target)).toThrow(/recovered/);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'complete']);
    expect(host.journal().operations.map(operation => operation.state)).toEqual(['ABANDONED', 'COMPLETED']);
    expect(calls.filter(command => command.includes(hook))).toHaveLength(1);
    expect(calls.some(command => command.includes('pm2 startOrRestart'))).toBe(false);
    expect(host.events.indexOf('target:restart')).toBeGreaterThan(host.events.lastIndexOf('storage:MUTATING'));
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, restarts: 1 });
  });

  it('RESTART_FENCED_REJECT never completes a child after hook rejection despite healthy original processes', () => {
    const host = makeHost({ config: { hooks: { restart: hook } } });
    const rb = makeRollbackHost({ restartCommand: hook });
    const calls: string[] = [];
    const target = makeTarget(host.events, { rb, onCommand: command => {
      calls.push(command);
      if (command.includes('pm2 stop') || command.includes(hook)) throw execFailure('');
    } });
    expect(() => host.deploy(target)).toThrow();
    expect(host.authority.actions).not.toContain('complete');
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon', 'begin', 'abandon']);
    expect(host.journal().operations.every(operation => operation.state !== 'COMPLETED')).toBe(true);
    expect(calls.filter(command => command.includes(hook))).toHaveLength(2);
    expect(calls.some(command => command.includes('pm2 startOrRestart'))).toBe(false);
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true, restarts: 0 });
  });

  it('RESTART_FENCED_MANUAL uses the hook for the exact previous SHA', () => {
    const host = makeHost({ config: { hooks: { restart: hook } } });
    const rb = makeRollbackHost({ restartCommand: hook });
    const calls: string[] = [];
    const target = makeTarget(host.events, { rb, onCommand: command => { calls.push(command); } });
    expect(host.rollback(target).healthy).toBe(true);
    expect(rb.s).toMatchObject({ current: PREV_DIR, running: PREV_DIR, restarts: 1 });
    expect(host.authority.actions).toEqual(['begin', 'complete']);
    expect(calls.filter(command => command.includes(hook))).toHaveLength(1);
    expect(calls.some(command => command.includes('pm2 startOrRestart'))).toBe(false);
  });

  it.each([false, true])('RESTART_FENCED_CHILD_REJECTS_HEALTHY guards the restart child acceptance=%s', accepted => {
    const rb = makeRollbackHost({ restartCommand: hook,
      probeSha: call => call <= 4 ? OTHER_SHA : undefined });
    const host = makeHost({ config: { hooks: { restart: hook } } });
    let hookCalls = 0;
    const commands: string[] = [];
    const target = makeTarget(host.events, { rb, onCommand: command => {
      commands.push(command);
      if (command.includes(hook)) {
        hookCalls++;
        if (hookCalls === 3 && !accepted) throw execFailure('');
      }
    } });
    expect(() => host.deploy(target)).toThrow(accepted ? /recovered/ : /manual recovery/i);
    expect(hookCalls).toBe(3);
    const requests = host.authority.requests.map(request => JSON.parse(request));
    expect(requests[4]).toMatchObject({ kind: 'recovery-restart',
      parentOperationId: requests[2].operationId, targetSha: ORIG_FULL, targetRelease: ORIG_DIR });
    expect(host.journal().operations.map(operation => operation.state))
      .toEqual(['ABANDONED', 'ABANDONED', accepted ? 'COMPLETED' : 'ABANDONED']);
    expect(host.authority.actions.at(-1)).toBe(accepted ? 'complete' : 'abandon');
    expect(phaseOf(target).phase).toBe(accepted ? 'recovered' : 'forward-recovery-failed');
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true,
      restarts: accepted ? 3 : 2 });
    expect(commands.some(command => command.includes('pm2 startOrRestart'))).toBe(false);
  });
});

describe('PKG-272 unfenced running facts', () => {
  it.each([false, true])('RESTART_FALLBACK_REJECTION_PRESERVES_RUNNING_FACT fallback accepts=%s', accepted => {
    const hook = 'guarded-activate-runtime';
    const config = relConfig({ hooks: { restart: hook }, deliveryEvent: true,
      postDeployChecks: [{ name: 'post-smoke', command: 'post-check-fail', onFailure: 'rollback' }] });
    config.transitionAuthority = null;
    const events: string[] = [];
    const rb = makeRollbackHost({ restartCommand: hook });
    let hookCalls = 0;
    const commands: string[] = [];
    const target = makeTarget(events, { rb, onCommand: command => {
      commands.push(command);
      if (command.includes('post-check-fail')) throw execFailure('');
      if (command.includes(hook)) {
        hookCalls++;
        if (hookCalls === 2 || (hookCalls === 3 && !accepted)) {
          rb.s.running = rb.s.current;
          rb.s.online = true; // partial activation can resume the right app yet return nonzero
          throw execFailure('');
        }
      }
    } });
    expect(() => release.deployRelease(config, { skipMigrate: true }, {
      runtime: { execFileSync: target.execFileSync }, sleep: () => {},
      now: () => Date.parse('2026-07-10T09:00:00Z'),
    })).toThrow(/MANUAL RECOVERY REQUIRED/);
    expect(hookCalls).toBe(3);
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true });
    expect(phaseOf(target)).toMatchObject({ phase: 'post-deploy-rollback-failed' });
    const delivery = JSON.parse(target.t.deliveries.at(-1)!);
    expect(delivery).toMatchObject({ appsState: 'running', activeRelease: ORIG_DIR,
      recovery: { verified: false, outcome: 'rollback-failed-running' } });
    expect(commands.some(command => command.includes('pm2 startOrRestart'))).toBe(false);
  });
});

describe('PKG-272 fenced post-deploy rejection reporting', () => {
  it('RESTART_FENCED_POST_REJECT never reports rolled-back when a healthy target fails its activation guard', () => {
    const hook = 'guarded-activate-runtime';
    const host = makeHost({ config: { hooks: { restart: hook }, deliveryEvent: true,
      postDeployChecks: [{ name: 'post-smoke', command: 'post-check-fail', onFailure: 'rollback' }] } });
    const rb = makeRollbackHost({ restartCommand: hook });
    let hookCalls = 0;
    const commands: string[] = [];
    const target = makeTarget(host.events, { rb, onCommand: command => {
      commands.push(command);
      if (command.includes('post-check-fail')) throw execFailure('');
      if (command.includes(hook)) {
        hookCalls++;
        if (hookCalls > 1) {
          rb.s.running = rb.s.current;
          rb.s.online = true;
          throw execFailure('');
        }
      }
    } });
    expect(() => host.deploy(target)).toThrow(/manual recovery/i);
    expect(hookCalls).toBe(3);
    expect(host.authority.actions).toEqual(['begin', 'abandon', 'begin', 'abandon', 'begin', 'abandon']);
    expect(host.journal().operations.every(operation => operation.state === 'ABANDONED')).toBe(true);
    expect(phaseOf(target)).toMatchObject({ phase: 'post-deploy-rollback-failed' });
    const deliveries = target.t.deliveries.map(body => JSON.parse(body));
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every(delivery => delivery.recovery.outcome !== 'rolled-back')).toBe(true);
    expect(deliveries.at(-1)).toMatchObject({ appsState: 'running', activeRelease: ORIG_DIR,
      recovery: { outcome: 'rollback-failed-running', verified: false } });
    expect(rb.s).toMatchObject({ current: ORIG_DIR, running: ORIG_DIR, online: true });
    expect(commands.some(command => command.includes('pm2 startOrRestart'))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import crypto from 'crypto';

const require = createRequire(__filename);
const kit = require('../index.js');
const release = require('../release.js');
const { createTransitionOperationManager } = require('../transition-operation.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = 'b'.repeat(40);
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const RUNTIME_TAGS = ['pre-hook', 'install', 'build', 'stop', 'backup', 'migrate', 'flip', 'check', 'restore', 'restart'];

// Rollback hosts: two releases whose full SHAs share no prefix, so a 12-char or dir-name inference cannot pass.
const ORIG_DIR = 'releases/00000000aaaa-20260709T090000Z';
const PREV_DIR = 'releases/00000000bbbb-20260708T090000Z';
const ORIG_FULL = `0123456789ab${'c'.repeat(28)}`;
const PREV_FULL = `fedcba987654${'d'.repeat(28)}`;
const SHA_OF: Record<string, string> = { [ORIG_DIR]: ORIG_FULL, [PREV_DIR]: PREV_FULL };

// What execFileSync throws for a failed command: the child's stdout is still attached to the error.
const execFailure = (stdout: string) => Object.assign(new Error('Command failed'), { stdout, status: 1 });

interface RollbackOpts { flipFails?: (relTarget: string) => boolean; checkFails?: boolean; headFails?: (relDir: string) => boolean }

// Observable rollback host state: release SHA map, current/previous pointers, the running process pointer.
function makeRollbackHost(opts: RollbackOpts = {}) {
  const s: { current: string; previous: string; running: string; flips: string[]; restarts: number; headReads: Array<{ dir: string; sha: string }>; probeCalls: number } = {
    current: ORIG_DIR, previous: PREV_DIR, running: ORIG_DIR,
    flips: [], restarts: 0, headReads: [], probeCalls: 0,
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
      s.flips.push(flip[1]);
      if (opts.flipFails?.(flip[1])) throw execFailure('');
      if (flip[2].endsWith('/current')) s.current = flip[1];
      return '';
    }
    if (cmd.includes('pre-restart-smoke')) { if (opts.checkFails) throw execFailure(''); return ''; }
    if (/pm2 startOrRestart/.test(cmd)) { s.restarts += 1; s.running = s.current; return ''; }
    if (cmd.startsWith('readlink /srv/app/current')) return s.current;
    if (cmd.startsWith('readlink /srv/app/previous')) return s.previous;
    if (/^readlink -f \/srv\/app\/releases\//.test(cmd)) return cmd.slice('readlink -f '.length);
    if (cmd.includes('readlink -f /proc/111/cwd')) return `/srv/app/${s.running}`;
    if (cmd.includes('get-running-sha')) { s.probeCalls += 1; return SHA_OF[s.running]; }
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
function makeAuthority(events: string[], fails: (action: string, count: number) => boolean = () => false) {
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
      if (fails(action, actions.filter((a) => a === action).length)) throw new Error('timeout');
      return { planned: false, operationId: request.operationId, requestDigest: sha256(bytes), receipt: 'receipt-1', state: terminal[action] };
    },
  };
}

// Content-aware target: answers the real preflight/lock/git/pm2 commands and keeps the phase journal the
// way the host would, by parsing what persistState's atomic shell command writes and replaying it on read.
function makeTarget(events: string[], over: { builtSha?: string; stateRead?: StateRead; shaProbe?: (call: number) => string; headFails?: boolean; rb?: ReturnType<typeof makeRollbackHost> } = {}) {
  const t: { stateText: string | null; lastDeploy: string | null; shaCalls: number; stopped: boolean; stateWrites: string[] } = { stateText: null, lastDeploy: null, shaCalls: 0, stopped: false, stateWrites: [] };
  const tags: Array<[RegExp, string]> = [
    [/pre-hook/, 'pre-hook'], [/npm ci/, 'install'], [/npm run build/, 'build'], [/pm2 stop/, 'stop'],
    [/run-backup/, 'backup'], [/run-migrate/, 'migrate'], [/mv -Tf/, 'flip'], [/pm2 (startOrRestart|start|restart)/, 'restart'],
    [/pre-restart-smoke/, 'check'], [/run-restore/, 'restore'],
  ];
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    const tag = tags.find(([re]) => re.test(cmd));
    if (tag) events.push(`target:${tag[1]}`);
    const modelled = over.rb?.handle(cmd);
    if (modelled !== undefined) return modelled;
    if (over.headFails && cmd.startsWith('cd /srv/app/releases/') && cmd.endsWith('git rev-parse HEAD')) throw execFailure(over.builtSha ?? SHA);
    if (cmd.includes('.deploy-kit-last-deploy.json.tmp')) { t.lastDeploy = cmd; events.push('target:last-deploy'); return ''; }
    if (cmd.includes('.deploy-kit-state.json')) {
      if (cmd.includes('[ -e ')) {
        if (over.stateRead === 'fails') throw Object.assign(new Error('read failed'), { stdout: '' });
        if (over.stateRead === 'corrupt') return 'present\n{not json';
        if (over.stateRead === 'empty') return 'present\n';
        return t.stateText === null ? 'absent\n' : `present\n${t.stateText}`;
      }
      const written = /printf '%s' '(.*)' > \S+ && mv -f \S+ \S+$/s.exec(cmd);
      if (!written) throw new Error(`unrecognised phase journal command: ${cmd}`);
      t.stateText = written[1];
      t.stateWrites.push(written[1]);
      const phase: Phase = JSON.parse(written[1]);
      events.push(`target:state:${phase.phase}`);
      return '';
    }
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
  return { t, execFileSync };
}

interface ConfigOver { preRestartChecks?: Array<{ name: string; command: string }>; layout?: Record<string, unknown> }
const relConfig = (over: ConfigOver = {}) => mergeConfig(DEFAULT_CONFIG, {
  ...(over.preRestartChecks ? { preRestartChecks: over.preRestartChecks } : {}),
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 },
  hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore' },
  preDeployChecks: [{ name: 'pre', command: 'pre-hook' }],
  layout: { type: 'releases', keepReleases: 4, sharedPaths: [], releaseChecks: [], runningShaCommand: 'get-running-sha', ...over.layout },
  transitionAuthority: { command: 'authority', scope: 'host-a' },
});

// One host: durable storage + journal state survive across invocations, as the real host's files would.
function makeHost(opts: { authorityFails?: (action: string, count: number) => boolean; config?: ConfigOver } = {}) {
  const events: string[] = [];
  const durable = makeStorage(events);
  const authority = makeAuthority(events, opts.authorityFails);
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

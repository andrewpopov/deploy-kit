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
const RUNTIME_TAGS = ['pre-hook', 'install', 'build', 'stop', 'backup', 'migrate', 'flip', 'restart'];

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
function makeTarget(events: string[], over: { builtSha?: string; stateRead?: StateRead; shaProbe?: (call: number) => string } = {}) {
  const t: { stateText: string | null; lastDeploy: string | null; shaCalls: number; stopped: boolean; stateWrites: string[] } = { stateText: null, lastDeploy: null, shaCalls: 0, stopped: false, stateWrites: [] };
  const tags: Array<[RegExp, string]> = [
    [/pre-hook/, 'pre-hook'], [/npm ci/, 'install'], [/npm run build/, 'build'], [/pm2 stop/, 'stop'],
    [/run-backup/, 'backup'], [/run-migrate/, 'migrate'], [/mv -Tf/, 'flip'], [/pm2 (startOrRestart|start|restart)/, 'restart'],
  ];
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    const tag = tags.find(([re]) => re.test(cmd));
    if (tag) events.push(`target:${tag[1]}`);
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

const relConfig = () => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 },
  hooks: { install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore' },
  preDeployChecks: [{ name: 'pre', command: 'pre-hook' }],
  layout: { type: 'releases', keepReleases: 4, sharedPaths: [], releaseChecks: [], runningShaCommand: 'get-running-sha' },
  transitionAuthority: { command: 'authority', scope: 'host-a' },
});

// One host: durable storage + journal state survive across invocations, as the real host's files would.
function makeHost(opts: { authorityFails?: (action: string, count: number) => boolean } = {}) {
  const events: string[] = [];
  const durable = makeStorage(events);
  const authority = makeAuthority(events, opts.authorityFails);
  let uuids = 0;
  const uuid = () => `00000000-0000-4000-8000-${String(++uuids).padStart(12, '0')}`;
  const deploy = (target: ReturnType<typeof makeTarget>) => release.deployRelease(relConfig(), {}, {
    runtime: { execFileSync: target.execFileSync },
    sleep: () => {},
    now: () => Date.parse('2026-07-10T09:00:00Z'),
    transitionManagerFactory: (cfg: unknown, c: Record<string, unknown>) => createTransitionOperationManager(
      cfg, { ...c, storage: durable.storage, send: authority.send, uuid },
    ),
  });
  const journal = (): Journal => JSON.parse(String(durable.store.text));
  const runtimeEvents = (from = 0) => events.slice(from).filter((e) => RUNTIME_TAGS.map((tag) => `target:${tag}`).includes(e));
  return { events, durable, authority, deploy, journal, runtimeEvents };
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
});

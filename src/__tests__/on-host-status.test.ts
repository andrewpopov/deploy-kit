import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(__filename);
const { onHostStatus } = require('../on-host/status.js');
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

const RUN_ID = '20261023T103000Z-0123456789ab-deadbeef';
const OTHER_RUN_ID = '20261023T103000Z-0123456789ab-cafebabe';
const REQUEST_ID = 'req-deploy-app-20261023-2-e0';
const config = { mode: 'ssh', host: 'dkapp@host', projectDir: '/srv/app', appNames: ['app'], stepTimeoutSeconds: 60 };

let home: string;
let bin: string;
let unitState = 'inactive';
let sshCalls: string[];

// The fake target: the ssh command runs for real in `sh` against a temp HOME, with a stub systemctl.
const runtime = {
  execFileSync: (_file: string, args: string[]) => {
    const command = args[args.length - 1];
    sshCalls.push(command);
    return realExecFileSync('sh', ['-c', command], {
      encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_RUNTIME_DIR: '/tmp', DK_UNIT_STATE: unitState },
    });
  },
};

const put = (rel: string, content: unknown) => {
  const file = path.join(home, '.deploy-kit', rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
};
const putRun = (name: string, content: unknown = '') => put(`runs/${RUN_ID}/${name}`, content);
const accepted = { runId: RUN_ID, acceptedAt: 'x' };
const terminal = { runId: RUN_ID, kind: 'deploy', result: { status: 'deployed', stage: 'done', liveBefore: null, liveAfter: null, migrated: false, migrationsPending: null, backupId: null, effectsClean: null, recovery: { action: 'none', verified: false }, error: null }, effects: [], kitArtifact: {}, finishedAt: '2026-10-23T10:40:00Z' };
const reservation = { requestId: REQUEST_ID, gen: 1, state: 'accepted', runId: RUN_ID, at: 'x', liveBefore: 'a'.repeat(40), prev: null };
const status = (opts: Record<string, unknown> = {}) => onHostStatus(config, RUN_ID, { runtime, ...opts });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-status-home-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-status-bin-'));
  unitState = 'inactive';
  sshCalls = [];
  const stub = path.join(bin, 'systemctl');
  fs.writeFileSync(stub, '#!/bin/sh\necho "ActiveState=$DK_UNIT_STATE"\necho "SubState=x"\n', { mode: 0o755 });
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(bin, { recursive: true, force: true });
});

describe('on-host-status: states', () => {
  it('absent: no run dir', () => {
    const s = status();
    expect(s.state).toBe('absent');
    expect(s.runId).toBe(RUN_ID);
  });

  it('staged: a manifest or bundle but no started', () => {
    putRun('manifest.sha256', 'x');
    expect(status().state).toBe('staged');
  });

  it('claimed: started but no accepted.json and no refusal', () => {
    putRun('manifest.sha256', 'x');
    putRun('started', 'a'.repeat(32));
    expect(status().state).toBe('claimed');
  });

  it('refused: a refusal record, with its code', () => {
    putRun('started', 'a'.repeat(32));
    putRun('refused.json', { runId: RUN_ID, code: 'request-taken' });
    const s = status();
    expect(s.state).toBe('refused');
    expect(s.code).toBe('request-taken');
  });

  it('refused: the unit ended without ever claiming the run', () => {
    putRun('manifest.sha256', 'x');
    putRun('result-unstarted.json', { runId: RUN_ID, invocationId: 'a'.repeat(32), serviceResult: 'exit-code', exitCode: 'exited', exitStatus: '1', finishedAt: 1 });
    expect(status()).toMatchObject({ state: 'refused', code: 'unit-never-started' });
  });

  it('accepted-running: accepted.json and a live unit', () => {
    putRun('started', 'a'.repeat(32));
    putRun('accepted.json', accepted);
    unitState = 'active';
    expect(status().state).toBe('accepted-running');
  });

  it('terminal: accepted.json and a valid terminal.json, returned in the result', () => {
    putRun('started', 'a'.repeat(32));
    putRun('accepted.json', accepted);
    putRun('terminal.json', terminal);
    const s = status();
    expect(s.state).toBe('terminal');
    expect(s.terminal).toEqual(terminal);
  });

  it('unknown, not failed: accepted, no terminal.json, unit not running', () => {
    putRun('started', 'a'.repeat(32));
    putRun('accepted.json', accepted);
    unitState = 'failed';
    const s = status();
    expect(s.state).toBe('unknown');
    expect(s.state).not.toBe('failed');
    expect(s.reasons.join()).toMatch(/production may have changed/);
  });

  it('unknown: the reply is unusable or the transport fails', () => {
    const broken = { execFileSync: () => 'garbage' };
    expect(onHostStatus(config, RUN_ID, { runtime: broken })).toMatchObject({ state: 'unknown', transport: 'lost' });
    const down = { execFileSync: () => { throw Object.assign(new Error('ssh'), { stdout: '', stderr: '' }); } };
    expect(onHostStatus(config, RUN_ID, { runtime: down })).toMatchObject({ state: 'unknown', transport: 'lost' });
  });
});

describe('on-host-status: reservation and corrupt records fail closed', () => {
  it('returns the reservation for --request, and null when the file is absent', () => {
    expect(status({ requestId: REQUEST_ID }).reservation).toBeNull();
    put(`requests/${REQUEST_ID}.json`, reservation);
    putRun('started', 'a'.repeat(32));
    const s = status({ requestId: REQUEST_ID });
    expect(s.reservation).toEqual(reservation);
    expect(s.state).toBe('claimed');
  });

  it.each([
    ['unparsable JSON', '{nope'],
    ['an empty file', ''],
    ['a foreign runId', JSON.stringify({ ...accepted, runId: OTHER_RUN_ID })],
    ['a non-object', '[]'],
  ])('a corrupt accepted.json (%s) is unknown with a corrupt detail', (_name, content) => {
    putRun('started', 'a'.repeat(32));
    putRun('accepted.json', content);
    const s = status();
    expect(s.state).toBe('unknown');
    expect(s.corrupt).toEqual(['accepted.json']);
    expect(s.reasons.join()).toMatch(/corrupt/);
  });

  it.each([
    ['unparsable JSON', '{"runId"'],
    ['missing result', JSON.stringify({ ...terminal, result: undefined })],
    ['a foreign runId', JSON.stringify({ ...terminal, runId: OTHER_RUN_ID })],
  ])('a corrupt terminal.json (%s) is unknown, never absent, even with a dead unit', (_name, content) => {
    putRun('started', 'a'.repeat(32));
    putRun('accepted.json', accepted);
    putRun('terminal.json', content);
    const s = status();
    expect(s.state).toBe('unknown');
    expect(s.corrupt).toEqual(['terminal.json']);
  });

  it('a corrupt terminal.json does not read as absent while the unit still runs', () => {
    putRun('accepted.json', accepted);
    putRun('terminal.json', 'xx');
    unitState = 'active';
    expect(status().state).toBe('unknown');
  });

  it('a corrupt refusal record is unknown, not claimed or refused', () => {
    putRun('started', 'a'.repeat(32));
    putRun('refused.json', '{');
    expect(status()).toMatchObject({ state: 'unknown', corrupt: ['refused.json'] });
  });

  it.each([
    ['unparsable', '{'],
    ['wrong requestId', JSON.stringify({ ...reservation, requestId: 'other' })],
    ['gen 0', JSON.stringify({ ...reservation, gen: 0 })],
    ['bad state', JSON.stringify({ ...reservation, state: 'held' })],
    ['bad prev', JSON.stringify({ ...reservation, prev: { runId: 'x' } })],
  ])('a corrupt reservation (%s) is unknown, even when the run dir is absent', (_name, content) => {
    put(`requests/${REQUEST_ID}.json`, content);
    const s = status({ requestId: REQUEST_ID });
    expect(s.state).toBe('unknown');
    expect(s.corrupt).toEqual(['reservation']);
    expect(s.reservation).toBeNull();
  });

  it('accepted.json together with a refusal is inconsistent, so unknown', () => {
    putRun('accepted.json', accepted);
    putRun('refused.json', { runId: RUN_ID, code: 'late' });
    expect(status().state).toBe('unknown');
  });
});

describe('on-host-status: read-only and input checks', () => {
  const snapshot = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const full = path.join((e as any).parentPath ?? (e as any).path, e.name);
      const st = fs.lstatSync(full);
      return `${path.relative(dir, full)}|${st.mtimeMs}|${st.size}`;
    }).sort();

  it('leaves the target dir with the same file list and mtimes', async () => {
    putRun('started', 'a'.repeat(32));
    putRun('accepted.json', accepted);
    putRun('terminal.json', terminal);
    put(`requests/${REQUEST_ID}.json`, reservation);
    const before = snapshot(home);
    await new Promise((r) => setTimeout(r, 20));
    expect(status({ requestId: REQUEST_ID }).state).toBe('terminal');
    expect(snapshot(home)).toEqual(before);
    expect(sshCalls).toHaveLength(1);
  });

  it('absent calls create nothing', () => {
    status();
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it('rejects a malformed run id or request id before any ssh', () => {
    expect(() => onHostStatus(config, 'nope', { runtime })).toThrow(/ONHOST_RUN_ID/);
    expect(() => onHostStatus(config, RUN_ID, { runtime, requestId: 'a/../b' })).toThrow(/ONHOST_REQUEST_ID/);
    expect(sshCalls).toEqual([]);
  });
});

describe('on-host-status CLI', () => {
  let out = '';
  const spies = () => ['error', 'info', 'success', 'warning', 'step', 'header', 'divider'].map((m) => {
    const orig = log[m];
    log[m] = (msg: string) => { out += `${msg}\n`; };
    return () => { log[m] = orig; };
  });
  it('refuses bad usage by name', () => {
    out = '';
    const restore = spies();
    try {
      for (const argv of [['on-host-status'], ['on-host-status', RUN_ID, 'extra'], ['on-host-status', RUN_ID, '--request'], ['on-host-status', RUN_ID, '--bogus']]) {
        expect(cli.run(argv, { cwd: os.tmpdir() })).toBe(1);
      }
    } finally { restore.forEach((r) => r()); }
    expect(out).toContain('Usage: deploy-kit on-host-status');
  });
});

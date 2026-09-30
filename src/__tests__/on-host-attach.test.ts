import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(__filename);
const { attachReceipt, attachRun, parseState, RETRY_BACKOFF_SECONDS } = require('../on-host/attach.js');
const { appendReceipt, findReceipt } = require('../on-host/receipts.js');

const RUN_ID = '20260930T120000Z-0123456789ab-deadbeef';
const receipt = {
  app: '/srv/app', host: 'dkapp@host', unit: `deploy-kit-srv-app-${RUN_ID}`, runId: RUN_ID, runDir: `/srv/app/.deploy-kit/runs/${RUN_ID}`, sha: 'a'.repeat(40), startedAt: 'x',
};
const config = { mode: 'ssh', host: 'ignored@elsewhere', projectDir: '/srv/app', stepTimeoutSeconds: 60, ssh: { options: ['Port=2299'], strictHostKeyChecking: 'no' } };

const resultJson = (over = {}) => JSON.stringify({ runId: RUN_ID, invocationId: 'a'.repeat(32), serviceResult: 'success', exitCode: 'exited', exitStatus: '0', finishedAt: 1, ...over });
const outcomeJson = (over = {}) => JSON.stringify({ runId: RUN_ID, ok: true, finishedAt: 'x', ...over });

function stateOutput(rec: Record<string, string | null> = {}, unit = 'ActiveState=active\nSubState=running') {
  const names = ['started', 'outcome.json', 'result.json', 'result-unstarted.json'];
  return `${names.map((n) => `DK_FILE ${n}\n${rec[n] == null ? 'DK_ABSENT' : `${rec[n]}\nDK_PRESENT`}\n`).join('')}DK_UNIT\n${unit}\nDK_END\n`;
}
const logOutput = (text: string) => `DK_LOG_N=${Buffer.byteLength(text)}\n${text}`;

// Script ssh: each call gets the remote command and answers via `respond`.
function harness(respond: (kind: 'log' | 'state', command: string, n: number) => string | Error) {
  const calls: { kind: 'log' | 'state'; command: string; args: string[] }[] = [];
  const execFileSync = vi.fn((_file: string, args: string[]) => {
    const command = args[args.length - 1];
    const kind = command.includes('DK_LOG_N') ? 'log' : 'state';
    calls.push({ kind, command, args });
    const answer = respond(kind, command, calls.length);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  let clock = 0;
  const sleeps: number[] = [];
  const written: string[] = [];
  const messages: string[] = [];
  const log = { info: (m: string) => messages.push(m), success: (m: string) => messages.push(m), error: (m: string) => messages.push(m), warning: (m: string) => messages.push(m) };
  const deps = {
    runtime: { execFileSync }, log, write: (t: string) => written.push(t),
    sleep: (s: number) => { sleeps.push(s); clock += s * 1000; }, now: () => clock,
  };
  return { calls, sleeps, written, messages, deps };
}
const offsetOf = (command: string) => Number(/o=(\d+);/.exec(command)![1]);

describe('attach: log streaming and classification', () => {
  it('follows the log by the offset the remote reports and exits 0 from the records', () => {
    let logCalls = 0;
    const h = harness((kind) => {
      if (kind === 'log') {
        logCalls += 1;
        if (logCalls === 1) return logOutput('héllo\n');         // 7 bytes, 6 chars
        if (logCalls === 2) return logOutput('world\n');
        return logOutput('');
      }
      return logCalls < 2
        ? stateOutput({ started: 'a'.repeat(32) })
        : stateOutput({ started: 'a'.repeat(32), 'outcome.json': outcomeJson(), 'result.json': resultJson() }, 'ActiveState=inactive\nSubState=dead');
    });
    const code = attachReceipt(receipt, config, h.deps);
    expect(code).toBe(0);
    expect(h.written.join('')).toBe('héllo\nworld\n');
    const offsets = h.calls.filter((c) => c.kind === 'log').map((c) => offsetOf(c.command));
    expect(offsets.slice(0, 3)).toEqual([0, 7, 13]);             // byte offsets, not character offsets
    expect(h.messages.join('\n')).toContain('succeeded');
  });

  it('applies config ssh options and targets the receipt host, never the config host', () => {
    const h = harness((kind) => (kind === 'log' ? logOutput('') : stateOutput({ 'result.json': resultJson(), 'outcome.json': outcomeJson() })));
    attachReceipt(receipt, config, h.deps);
    const args = h.calls[0].args;
    expect(args).toContain('Port=2299');
    expect(args).toContain('dkapp@host');
    expect(args).not.toContain('ignored@elsewhere');
    expect(h.calls[0].command).not.toContain('cd /srv/app');
  });

  it.each([
    ['failed outcome', { 'outcome.json': outcomeJson({ ok: false, error: 'boom' }), 'result.json': resultJson({ exitCode: 'exited', exitStatus: '1', serviceResult: 'exit-code' }) }, 1],
    ['SIGKILL result', { 'result.json': resultJson({ serviceResult: 'signal', exitCode: 'killed', exitStatus: 'KILL' }) }, 1],
    ['clean result without outcome', { 'result.json': resultJson() }, 70],
    ['never started', { 'result-unstarted.json': resultJson() }, 1],
    ['wrong run id', { 'result.json': resultJson({ runId: 'x' }), 'outcome.json': outcomeJson() }, 70],
  ])('%s -> exit %i', (_name, records, expected) => {
    const h = harness((kind) => (kind === 'log' ? logOutput('') : stateOutput(records as Record<string, string>)));
    expect(attachReceipt(receipt, config, h.deps)).toBe(expected);
  });

  it('gives an inactive unit with no result a 30 s grace, then classifies (70)', () => {
    const h = harness((kind) => (kind === 'log' ? logOutput('') : stateOutput({}, 'ActiveState=inactive\nSubState=dead')));
    expect(attachReceipt(receipt, config, h.deps)).toBe(70);
    expect(h.sleeps.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThanOrEqual(30);
    expect(h.sleeps.every((s: number) => s === 3)).toBe(true);
  });

  it('keeps polling while the unit is active with no result', () => {
    let states = 0;
    const h = harness((kind) => {
      if (kind === 'log') return logOutput('');
      states += 1;
      return states < 4 ? stateOutput({}) : stateOutput({ 'result.json': resultJson(), 'outcome.json': outcomeJson() });
    });
    expect(attachReceipt(receipt, config, h.deps)).toBe(0);
    expect(states).toBeGreaterThanOrEqual(4);
  });
});

describe('attach: transport loss', () => {
  it('retries each failing call 5 times with backoff, then exits 75 naming the unit', () => {
    const h = harness(() => new Error('ssh: connection reset'));
    expect(attachReceipt(receipt, config, h.deps)).toBe(75);
    expect(h.calls).toHaveLength(6);                                // the call + 5 retries
    expect(h.sleeps).toEqual(RETRY_BACKOFF_SECONDS);
    expect(h.messages.join('\n')).toContain(`transport lost — the deploy continues on dkapp@host as ${receipt.unit}; reattach: deploy-kit attach ${RUN_ID}`);
  });

  it('a call that recovers within the budget is not fatal', () => {
    let n = 0;
    const h = harness((kind) => {
      n += 1;
      if (n <= 3) return new Error('flaky');
      return kind === 'log' ? logOutput('') : stateOutput({ 'result.json': resultJson(), 'outcome.json': outcomeJson() });
    });
    expect(attachReceipt(receipt, config, h.deps)).toBe(0);
    expect(h.sleeps.slice(0, 3)).toEqual([1, 2, 4]);
  });

  it('an incomplete state reply counts as a failed call, not as "no records"', () => {
    const h = harness((kind) => (kind === 'log' ? logOutput('') : 'DK_FILE started\nDK_ABSENT\n'));
    expect(attachReceipt(receipt, config, h.deps)).toBe(75);
  });
});

describe('parseState', () => {
  it('reads present and absent records and the unit state', () => {
    const s = parseState(stateOutput({ 'outcome.json': '{"a":1}' }, 'ActiveState=failed\nSubState=failed'));
    expect(s.outcome).toContain('"a":1');
    expect(s.result).toBeNull();
    expect(s.activeState).toBe('failed');
  });
  it('rejects a reply missing DK_END or a record section', () => {
    expect(parseState(stateOutput().replace('DK_END\n', ''))).toBeUndefined();
    expect(parseState('DK_UNIT\nActiveState=active\nDK_END\n')).toBeUndefined();
  });
});

describe('receipts and attachRun', () => {
  it('resolves the LAST usable receipt for a run id and refuses unknown or malformed ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-receipts-'));
    const file = path.join(dir, 'runs.jsonl');
    try {
      appendReceipt({ ...receipt, host: 'first@h' }, file);
      fs.appendFileSync(file, 'not json\n');
      appendReceipt({ ...receipt, runDir: 'relative/evil' }, file);       // unusable: skipped
      appendReceipt({ ...receipt, host: '-oProxyCommand=x' }, file);       // unusable: would be an ssh option
      appendReceipt({ ...receipt, host: 'last@h' }, file);
      expect(findReceipt(RUN_ID, file).host).toBe('last@h');
      expect(findReceipt('20260930T120000Z-ffffffffffff-00000000', file)).toBeNull();
      expect(findReceipt(RUN_ID, path.join(dir, 'missing.jsonl'))).toBeNull();

      const h = harness(() => logOutput(''));
      expect(attachRun('20260930T120000Z-ffffffffffff-00000000', config, { ...h.deps, receiptsPath: file })).toBe(1);
      expect(h.messages.join('\n')).toContain('ONHOST_NO_RECEIPT');
      expect(attachRun('nope', config, { ...h.deps, receiptsPath: file })).toBe(1);
      expect(h.calls).toHaveLength(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

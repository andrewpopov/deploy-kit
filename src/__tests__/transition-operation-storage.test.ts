import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { makeFakeFs, nodeEScript, runScriptOnFake, type FakeOpts, type FakeFs } from './durable-storage-fixture';

const require = createRequire(__filename);
const {
  createTransitionJournalStorage, createReleasePhaseStorage, TRANSITION_JOURNAL_SCRIPT, MAX_JOURNAL_BYTES, JOURNAL_FILE,
} = require('../transition-operation-storage.js');

if (typeof JOURNAL_FILE !== 'string') throw new TypeError('journal path must be a string');
const FILE: string = JOURNAL_FILE;
const PHASE_FILE = '.deploy-kit-state.json'; // the release phase record, NOT the operation journal
const config = { mode: 'local', projectDir: '/p' };

// Runs the real static script, decoded from the shell-quoted command actually sent, against the fake fs.
function targetRuntime(fake: FakeFs, calls: { cmd: string; input?: string }[] = []) {
  return {
    execFileSync(_file: string, args: string[], o: { input?: string }) {
      const cmd = args[args.length - 1];
      calls.push({ cmd, input: o.input });
      const script = nodeEScript(cmd);
      if (script === null) throw new TypeError(`not a node -e command: ${cmd}`);
      return runScriptOnFake(script, fake, o.input || '');
    },
  };
}

const makeFake = (opts: FakeOpts = {}) => makeFakeFs(FILE, opts);
const JSON_TEXT = JSON.stringify({ schemaVersion: 1, secret: 'RECEIPT-abc' });
const storageOver = (fake: FakeFs, calls?: { cmd: string; input?: string }[]) =>
  createTransitionJournalStorage(config, { runtime: targetRuntime(fake, calls) });

describe('transition journal storage write', () => {
  it('fsyncs file, closes, renames, fsyncs directory before acknowledging, mode 0600, exact bytes', () => {
    const fake = makeFake();
    const res = storageOver(fake).write(JSON_TEXT);
    expect(res).toEqual({ status: 'written', bytes: Buffer.byteLength(JSON_TEXT) });
    expect(fake.log).toEqual(['open-tmp', 'write', 'fsync-file', 'close', 'rename', 'open-dir', 'fsync-dir', 'close']);
    expect(fake.files.get(FILE)!.toString()).toBe(JSON_TEXT);
    expect([...fake.files.keys()]).toEqual([FILE]);
    expect([...fake.modes.values()]).toEqual([0o600]);
  });

  it('handles short writes', () => {
    const fake = makeFake({ chunk: 3 });
    storageOver(fake).write(JSON_TEXT);
    expect(fake.files.get(FILE)!.toString()).toBe(JSON_TEXT);
  });

  for (const step of ['write', 'fsync-file', 'rename', 'fsync-dir']) {
    it(`a failing ${step} never acknowledges, leaks nothing, cleans own temp before rename`, () => {
      const fake = makeFake({ failOn: step });
      let thrown: unknown;
      try { storageOver(fake).write(JSON_TEXT); } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(Error);
      if (!(thrown instanceof Error) || !('code' in thrown)) throw new TypeError('expected coded failure');
      expect(thrown.code).toBe('JOURNAL_FAILED');
      expect(thrown.message).not.toMatch(/SECRET|RECEIPT/);
      if (step !== 'fsync-dir') expect([...fake.files.keys()].filter((k) => k !== FILE)).toEqual([]);
      if (step === 'fsync-dir') expect(fake.log).not.toContain('unlink');
    });
  }

  it('sends payload only on stdin, command is static', () => {
    const calls: { cmd: string; input?: string }[] = [];
    storageOver(makeFake(), calls).write(JSON_TEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(`write\n${JSON_TEXT}`);
    expect(calls[0].cmd).not.toContain('RECEIPT-abc');
    expect(nodeEScript(calls[0].cmd)).toBe(TRANSITION_JOURNAL_SCRIPT);
  });

  it('rejects non-object, oversized and lone-surrogate input without any command', () => {
    const calls: { cmd: string; input?: string }[] = [];
    const s = storageOver(makeFake(), calls);
    for (const bad of ['[]', 'null', '1', '{', 42, JSON.stringify({ a: 'x'.repeat(MAX_JOURNAL_BYTES) }), '{"a":"\ud800"}']) {
      expect(() => s.write(bad)).toThrow(/journal storage failed/);
    }
    expect(calls).toEqual([]);
  });

  it('rejects a malformed acknowledgement', () => {
    for (const out of ['', 'not json', '{"v":1,"k":"written","bytes":1}', '{"v":1,"k":"written","bytes":2,"x":1}', '{"v":1,"k":"absent"}']) {
      const s = createTransitionJournalStorage(config, { runtime: { execFileSync: () => out } });
      expect(() => s.write('{}')).toThrow(/journal storage failed/);
    }
  });
});

describe('release phase storage (protected phase record)', () => {
  const phaseText = JSON.stringify({ phase: 'stopped', phaseJournalVersion: 1, layoutVersion: 1 });
  const phaseStorage = (fake: FakeFs, calls?: { cmd: string; input?: string }[]) =>
    createReleasePhaseStorage(config, { runtime: targetRuntime(fake, calls) });

  it('PHASE_WRAPPER_PATH_ISOLATION: addresses only .deploy-kit-state.json, never the operation journal', () => {
    const calls: { cmd: string; input?: string }[] = [];
    const fake = makeFakeFs(PHASE_FILE, { existing: Buffer.from(JSON_TEXT) });
    fake.files.set(FILE, Buffer.from('{"journal":true}'));
    phaseStorage(fake, calls).write(phaseText);
    expect(nodeEScript(calls[0].cmd)).toContain(`"${PHASE_FILE}"`);
    expect(nodeEScript(calls[0].cmd)).not.toContain(FILE);
    expect(fake.files.get(PHASE_FILE)!.toString()).toBe(phaseText);
    expect(fake.files.get(FILE)!.toString()).toBe('{"journal":true}'); // operation journal untouched
    expect(phaseStorage(fake).read()).toEqual(JSON.parse(phaseText));
  });

  it('PHASE_WRITE_ORDER: file fsync, close, rename, then parent fsync before acknowledging', () => {
    const fake = makeFakeFs(PHASE_FILE);
    expect(phaseStorage(fake).write(phaseText)).toEqual({ status: 'written', bytes: Buffer.byteLength(phaseText) });
    expect(fake.log).toEqual(['open-tmp', 'write', 'fsync-file', 'close', 'rename', 'open-dir', 'fsync-dir', 'close']);
    expect([...fake.files.keys()]).toEqual([PHASE_FILE]);
    expect([...fake.modes.values()]).toEqual([0o600]);
  });

  for (const step of ['fsync-file', 'rename', 'fsync-dir']) {
    it(`PHASE_WRITE_FAULT: a failing ${step} reports JOURNAL_FAILED (storage unknown), never an acknowledgement`, () => {
      const fake = makeFakeFs(PHASE_FILE, { failOn: step });
      let thrown: unknown;
      try { phaseStorage(fake).write(phaseText); } catch (e) { thrown = e; }
      if (!(thrown instanceof Error) || !('code' in thrown)) throw new TypeError('expected coded failure');
      expect(thrown.code).toBe('JOURNAL_FAILED');
      expect(thrown.message).not.toMatch(/SECRET/);
    });
  }

  it('PHASE_READ_ERRORS: absent is null; empty, malformed and unreadable fail closed', () => {
    expect(phaseStorage(makeFakeFs(PHASE_FILE)).read()).toBeNull();
    for (const existing of [Buffer.alloc(0), Buffer.from('{nope')]) {
      expect(() => phaseStorage(makeFakeFs(PHASE_FILE, { existing })).read()).toThrow(/journal storage failed/);
    }
    expect(() => phaseStorage(makeFakeFs(PHASE_FILE, { readCode: 'EACCES' })).read()).toThrow(/journal storage failed/);
  });
});

describe('transition journal storage read', () => {
  it('returns null only for ENOENT', () => {
    expect(storageOver(makeFake()).read()).toBeNull();
  });

  it('fails closed on EACCES instead of reporting absent', () => {
    expect(() => storageOver(makeFake({ readCode: 'EACCES' })).read()).toThrow(/journal storage failed/);
  });

  it('returns parsed JSON for a valid journal', () => {
    expect(storageOver(makeFake({ existing: Buffer.from(JSON_TEXT) })).read()).toEqual(JSON.parse(JSON_TEXT));
  });

  it('accepts exactly the max size and rejects one byte more', () => {
    const body = (n: number) => Buffer.from(`{"a":"${'x'.repeat(n - 8)}"}`);
    expect(storageOver(makeFake({ existing: body(MAX_JOURNAL_BYTES) })).read()).not.toBeNull();
    expect(() => storageOver(makeFake({ existing: body(MAX_JOURNAL_BYTES + 1) })).read()).toThrow(/journal storage failed/);
  });

  it('rejects empty, invalid JSON and invalid UTF-8 distinctly from absent', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('null'), Buffer.from('[]'), Buffer.from('1'), Buffer.from('{nope'), Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')])]) {
      expect(() => storageOver(makeFake({ existing: bytes })).read()).toThrow(/journal storage failed/);
    }
  });

  it('rejects malformed envelopes and does not leak subprocess stdout', () => {
    for (const out of ['{"v":1,"k":"data","b64":"@@@"}', '{"v":2,"k":"absent"}', '{"v":1,"k":"data","b64":"e30=","x":1}', 'LEAK-xyz']) {
      const s = createTransitionJournalStorage(config, { runtime: { execFileSync: () => out } });
      expect(() => s.read()).toThrow(/^deploy-kit: transition journal storage failed$/);
    }
  });
});

describe('transition journal storage dry run', () => {
  it('runs zero target commands and returns distinct results', () => {
    const calls: { cmd: string; input?: string }[] = [];
    const runtime = { dryRun: true, execFileSync: (_f: string, a: string[]) => { calls.push({ cmd: a[a.length - 1] }); return ''; } };
    const s = createTransitionJournalStorage(config, { runtime });
    expect(s.read()).toBeNull();
    expect(s.write(JSON_TEXT)).toEqual({ status: 'planned' });
    expect(calls).toEqual([]);
  });
});

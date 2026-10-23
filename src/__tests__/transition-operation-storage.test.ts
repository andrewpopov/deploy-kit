import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import vm from 'vm';
import nodeCrypto from 'crypto';

const require = createRequire(__filename);
const {
  createTransitionJournalStorage, TRANSITION_JOURNAL_SCRIPT, MAX_JOURNAL_BYTES, JOURNAL_FILE,
} = require('../transition-operation-storage.js');

if (typeof JOURNAL_FILE !== 'string') throw new TypeError('journal path must be a string');
const FILE: string = JOURNAL_FILE;
const config = { mode: 'local', projectDir: '/p' };

interface FakeOpts { failOn?: string; code?: string; chunk?: number; existing?: Buffer; readCode?: string }

// In-memory fs recording the order of durability-relevant calls.
function makeFakeFs(opts: FakeOpts = {}) {
  const files = new Map<string, Buffer>();
  if (opts.existing) files.set(FILE, opts.existing);
  const log: string[] = [];
  const fds = new Map<number, { path: string; pos: number }>();
  const modes = new Map<string, number>();
  let next = 10;
  const maybeFail = (step: string) => {
    if (opts.failOn === step) throw Object.assign(new Error('boom SECRET'), { code: opts.code || 'EIO' });
  };
  const fsApi = {
    readFileSync: (_fd: number) => Buffer.from(''),
    openSync(p: string, flags: string, mode?: number) {
      if (p === '.') { log.push('open-dir'); maybeFail('open-dir'); fds.set(next, { path: '.', pos: 0 }); return next++; }
      if (flags === 'r') {
        if (opts.readCode) throw Object.assign(new Error('x'), { code: opts.readCode });
        if (!files.has(p)) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      } else { log.push('open-tmp'); files.set(p, Buffer.alloc(0)); if (typeof mode !== 'number') throw new TypeError('temporary file mode required'); modes.set(p, mode); }
      fds.set(next, { path: p, pos: 0 });
      return next++;
    },
    readSync(fd: number, buf: Buffer, off: number, len: number) {
      const f = fds.get(fd)!;
      const n = files.get(f.path)!.copy(buf, off, f.pos, f.pos + len);
      f.pos += n;
      return n;
    },
    writeSync(fd: number, buf: Buffer, off: number, len: number) {
      maybeFail('write');
      const f = fds.get(fd)!;
      const n = Math.min(len, opts.chunk || len);
      files.set(f.path, Buffer.concat([files.get(f.path)!, buf.subarray(off, off + n)]));
      log.push('write');
      return n;
    },
    fsyncSync(fd: number) {
      const dir = fds.get(fd)!.path === '.';
      maybeFail(dir ? 'fsync-dir' : 'fsync-file');
      log.push(dir ? 'fsync-dir' : 'fsync-file');
    },
    closeSync(fd: number) { log.push('close'); fds.delete(fd); },
    renameSync(a: string, b: string) { maybeFail('rename'); log.push('rename'); files.set(b, files.get(a)!); files.delete(a); },
    unlinkSync(p: string) { log.push('unlink'); files.delete(p); },
  };
  return { fsApi, files, log, modes };
}

// Runs the real static target script in a vm against the fake fs.
function targetRuntime(fake: ReturnType<typeof makeFakeFs>, calls: { cmd: string; input?: string }[] = []) {
  return {
    execFileSync(_file: string, args: string[], o: { input?: string }) {
      const cmd = args[args.length - 1];
      calls.push({ cmd, input: o.input });
      let stdout = '';
      const proc = { stdout: { write: (s: string) => { stdout += s; } }, exitCode: 0 };
      const input = Buffer.from(o.input || '');
      const fsApi = { ...fake.fsApi, readFileSync: () => input };
      const req = (name: string) => (name === 'fs' ? fsApi : nodeCrypto);
      vm.runInNewContext(TRANSITION_JOURNAL_SCRIPT, { require: req, process: proc, Buffer });
      if (proc.exitCode !== 0) throw Object.assign(new Error('exit 1'), { stdout });
      return stdout;
    },
  };
}

const JSON_TEXT = JSON.stringify({ schemaVersion: 1, secret: 'RECEIPT-abc' });
const storageOver = (fake: ReturnType<typeof makeFakeFs>, calls?: { cmd: string; input?: string }[]) =>
  createTransitionJournalStorage(config, { runtime: targetRuntime(fake, calls) });

describe('transition journal storage write', () => {
  it('fsyncs file, closes, renames, fsyncs directory before acknowledging, mode 0600, exact bytes', () => {
    const fake = makeFakeFs();
    const res = storageOver(fake).write(JSON_TEXT);
    expect(res).toEqual({ status: 'written', bytes: Buffer.byteLength(JSON_TEXT) });
    expect(fake.log).toEqual(['open-tmp', 'write', 'fsync-file', 'close', 'rename', 'open-dir', 'fsync-dir', 'close']);
    expect(fake.files.get(FILE)!.toString()).toBe(JSON_TEXT);
    expect([...fake.files.keys()]).toEqual([FILE]);
    expect([...fake.modes.values()]).toEqual([0o600]);
  });

  it('handles short writes', () => {
    const fake = makeFakeFs({ chunk: 3 });
    storageOver(fake).write(JSON_TEXT);
    expect(fake.files.get(FILE)!.toString()).toBe(JSON_TEXT);
  });

  for (const step of ['write', 'fsync-file', 'rename', 'fsync-dir']) {
    it(`a failing ${step} never acknowledges, leaks nothing, cleans own temp before rename`, () => {
      const fake = makeFakeFs({ failOn: step });
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
    storageOver(makeFakeFs(), calls).write(JSON_TEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe(`write\n${JSON_TEXT}`);
    expect(calls[0].cmd).not.toContain('RECEIPT-abc');
  });

  it('rejects non-object, oversized and lone-surrogate input without any command', () => {
    const calls: { cmd: string; input?: string }[] = [];
    const s = storageOver(makeFakeFs(), calls);
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

describe('transition journal storage read', () => {
  it('returns null only for ENOENT', () => {
    expect(storageOver(makeFakeFs()).read()).toBeNull();
  });

  it('fails closed on EACCES instead of reporting absent', () => {
    expect(() => storageOver(makeFakeFs({ readCode: 'EACCES' })).read()).toThrow(/journal storage failed/);
  });

  it('returns parsed JSON for a valid journal', () => {
    expect(storageOver(makeFakeFs({ existing: Buffer.from(JSON_TEXT) })).read()).toEqual(JSON.parse(JSON_TEXT));
  });

  it('accepts exactly the max size and rejects one byte more', () => {
    const body = (n: number) => Buffer.from(`{"a":"${'x'.repeat(n - 8)}"}`);
    expect(storageOver(makeFakeFs({ existing: body(MAX_JOURNAL_BYTES) })).read()).not.toBeNull();
    expect(() => storageOver(makeFakeFs({ existing: body(MAX_JOURNAL_BYTES + 1) })).read()).toThrow(/journal storage failed/);
  });

  it('rejects empty, invalid JSON and invalid UTF-8 distinctly from absent', () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from('null'), Buffer.from('[]'), Buffer.from('1'), Buffer.from('{nope'), Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d])]) {
      expect(() => storageOver(makeFakeFs({ existing: bytes })).read()).toThrow(/journal storage failed/);
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

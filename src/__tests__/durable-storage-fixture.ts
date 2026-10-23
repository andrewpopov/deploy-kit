import vm from 'vm';
import nodeCrypto from 'crypto';

export interface FakeOpts { failOn?: string; code?: string; chunk?: number; existing?: Buffer; readCode?: string }

// In-memory fs for one fixed file, recording the order of durability-relevant calls.
// `setFail` retargets the injected fault between invocations (open-dir/write/fsync-file/rename/fsync-dir).
export function makeFakeFs(file: string, opts: FakeOpts = {}) {
  const files = new Map<string, Buffer>();
  if (opts.existing) files.set(file, opts.existing);
  const log: string[] = [];
  const fds = new Map<number, { path: string; pos: number }>();
  const modes = new Map<string, number>();
  let next = 10;
  let failOn = opts.failOn;
  const maybeFail = (step: string) => {
    if (failOn === step) throw Object.assign(new Error('boom SECRET'), { code: opts.code || 'EIO' });
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
  return { fsApi, files, log, modes, setFail(step?: string) { failOn = step; } };
}
export type FakeFs = ReturnType<typeof makeFakeFs>;

// The `node -e '<script>'` body of a target command, un-shell-quoted ('\'' -> '), or null.
export function nodeEScript(command: string): string | null {
  const quoted = /(?:^|&& )node -e '((?:[^']|'\\'')*)'$/.exec(command);
  return quoted ? quoted[1].replace(/'\\''/g, "'") : null;
}

// Runs a real static target script in a vm against the fake fs; exit 1 throws like a failed command.
export function runScriptOnFake(script: string, fake: FakeFs, input: string): string {
  let stdout = '';
  const proc = { stdout: { write: (s: string) => { stdout += s; } }, exitCode: 0 };
  const bytes = Buffer.from(input);
  const fsApi = { ...fake.fsApi, readFileSync: () => bytes };
  const req = (name: string) => (name === 'fs' ? fsApi : nodeCrypto);
  vm.runInNewContext(script, { require: req, process: proc, Buffer });
  if (proc.exitCode !== 0) throw Object.assign(new Error('Command failed'), { stdout, status: 1 });
  return stdout;
}

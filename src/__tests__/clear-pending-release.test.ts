import {
  describe, it, expect, afterEach, vi,
} from 'vitest';
import { createRequire } from 'module';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const require = createRequire(__filename);
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };
const { PENDING_RELEASE_PATH, clearPendingReleasePointer } = require('../auto-cut.js') as {
  PENDING_RELEASE_PATH: string;
  clearPendingReleasePointer: (options?: any, ctx?: any) => any;
};

// PKG: ZIRK-49-adjacent auto-cut trap — a pending-release pointer that pins
// every deploy to a release that cannot pass health, with no escape but an
// undocumented `rm`. `clear-pending-release` is the documented escape. These
// tests drive the CLI VERB itself (cli.run), not just the underlying
// function — see the port-guard comment in cli.js on why that distinction
// matters: a bug can hide entirely in the subcommand wiring.

function captureLog(): { out: () => string; restore: () => void } {
  let out = '';
  const sink = (m: string): void => { out += String(m) + '\n'; };
  const spies = ['error', 'success', 'info', 'step', 'header', 'warning', 'divider'].map((m) =>
    log[m] ? (vi.spyOn(log, m).mockImplementation(sink)) : null,
  );
  return { out: () => out, restore: () => { for (const s of spies) s?.mockRestore(); } };
}

function withProjectDir(fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-clear-pending-'));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writePending(dir: string, data: unknown) {
  const full = path.join(dir, PENDING_RELEASE_PATH);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('clear-pending-release CLI verb', () => {
  it('does NOT require a valid deploy config — no .deploy-kit.config.json in the dir at all', () => {
    withProjectDir((dir) => {
      writePending(dir, { sha: 'abc123', version: '1.1.1', prNumber: 42, at: '2026-08-01T00:00:00Z' });
      const cap = captureLog();
      const code = cli.run(['clear-pending-release', '--dir', dir], { cwd: '/nonexistent/wherever', env: {} });
      const out = cap.out();
      cap.restore();
      expect(code).toBe(0);
      expect(fs.existsSync(path.join(dir, PENDING_RELEASE_PATH))).toBe(false);
      expect(out).toMatch(/1\.1\.1/);
      expect(out).toMatch(/abc123/);
      expect(out).toMatch(/42/);
    });
  });

  it('reports version/sha/PR/timestamp before removing the file, then the file is gone', () => {
    withProjectDir((dir) => {
      writePending(dir, {
        sha: 'deadbeef00', version: '2.3.4', prNumber: 99, at: '2026-08-17T12:00:00Z',
      });
      const cap = captureLog();
      const code = cli.run(['clear-pending-release', '--dir', dir], { cwd: dir, env: {} });
      const out = cap.out();
      cap.restore();
      expect(code).toBe(0);
      expect(out).toMatch(/2\.3\.4/);
      expect(out).toMatch(/deadbeef00/);
      expect(out).toMatch(/99/);
      expect(out).toMatch(/2026-08-17T12:00:00Z/);
      // Explicit about what clearing does NOT do.
      expect(out).toMatch(/does NOT unpublish/i);
      expect(out).toMatch(/stays merged and released/i);
      expect(fs.existsSync(path.join(dir, PENDING_RELEASE_PATH))).toBe(false);
    });
  });

  it('is idempotent: no pending release exits 0 and says so plainly', () => {
    withProjectDir((dir) => {
      const cap = captureLog();
      const code = cli.run(['clear-pending-release', '--dir', dir], { cwd: dir, env: {} });
      const out = cap.out();
      cap.restore();
      expect(code).toBe(0);
      expect(out).toMatch(/nothing to clear/i);
    });
  });

  it('--json prints the parsed result and clears the file', () => {
    withProjectDir((dir) => {
      writePending(dir, { sha: 'cafef00d', version: '3.0.0', prNumber: 7, at: '2026-01-01T00:00:00Z' });
      const cap = captureLog();
      let printed = '';
      const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { printed = m; });
      const code = cli.run(['clear-pending-release', '--dir', dir, '--json'], { cwd: dir, env: {} });
      logSpy.mockRestore();
      cap.restore();
      expect(code).toBe(0);
      const parsed = JSON.parse(printed);
      expect(parsed.existed).toBe(true);
      expect(parsed.cleared).toBe(true);
      expect(parsed.pending.sha).toBe('cafef00d');
      expect(parsed.pending.version).toBe('3.0.0');
      expect(parsed.pending.prNumber).toBe(7);
      expect(fs.existsSync(path.join(dir, PENDING_RELEASE_PATH))).toBe(false);
    });
  });

  it('--json on the idempotent no-pending case reports existed:false and exits 0', () => {
    withProjectDir((dir) => {
      let printed = '';
      const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => { printed = m; });
      const code = cli.run(['clear-pending-release', '--dir', dir, '--json'], { cwd: dir, env: {} });
      logSpy.mockRestore();
      expect(code).toBe(0);
      expect(JSON.parse(printed)).toEqual({ existed: false, cleared: false });
    });
  });

  it('a corrupt pointer file: reports it could not be parsed rather than fabricating contents, still offers to remove it', () => {
    withProjectDir((dir) => {
      writePending(dir, '{ not valid json');
      const cap = captureLog();
      const code = cli.run(['clear-pending-release', '--dir', dir], { cwd: dir, env: {} });
      const out = cap.out();
      cap.restore();
      expect(code).toBe(0);
      expect(out).toMatch(/could not be parsed/i);
      expect(fs.existsSync(path.join(dir, PENDING_RELEASE_PATH))).toBe(false);
    });
  });

  it('rejects an unsupported flag before doing anything', () => {
    withProjectDir((dir) => {
      const cap = captureLog();
      const code = cli.run(['clear-pending-release', '--skip-build'], { cwd: dir, env: {} });
      const out = cap.out();
      cap.restore();
      expect(code).toBe(1);
      expect(out).toMatch(/clear-pending-release does not support: --skip-build/);
    });
  });
});

describe('clearPendingReleasePointer (underlying function)', () => {
  it('a file that exists but cannot be removed reports cleared:false with an error, exit non-zero via the CLI', () => {
    withProjectDir((dir) => {
      writePending(dir, { sha: 'abc', version: '1.0.0', prNumber: 1, at: 'now' });
      const full = path.join(dir, PENDING_RELEASE_PATH);
      const fsImpl = {
        existsSync: fs.existsSync,
        readFileSync: fs.readFileSync,
        unlinkSync: (p: string) => {
          if (p === full) throw new Error('EACCES: permission denied');
          return fs.unlinkSync(p);
        },
      };
      const result = clearPendingReleasePointer({ projectRoot: dir }, { fs: fsImpl });
      expect(result.existed).toBe(true);
      expect(result.cleared).toBe(false);
      expect(result.error).toMatch(/permission denied/);
      // The file must still be there — a failed removal must not silently succeed.
      expect(fs.existsSync(full)).toBe(true);
    });
  });
});

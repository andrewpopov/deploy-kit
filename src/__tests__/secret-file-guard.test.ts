import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { verifyNoSecrets } from '../secret-file-guard';

const roots: string[] = [];
const policy = {
  patterns: [
    { name: '.env', kind: 'basename-equals', value: '.env' },
    { name: '.env.bak*', kind: 'basename-prefix', value: '.env.bak' },
    { name: '*.pem', kind: 'basename-suffix', value: '.pem' },
    { name: '.gnupg/', kind: 'path-segment', value: '.gnupg' },
    { name: 'backups/ (repo root)', kind: 'root-path', value: 'backups' },
  ],
};

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-kit-secret-guard-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

function write(root: string, relativePath: string) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, 'secret');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verifyNoSecrets', () => {
  it('accepts a clean repository and legitimate example files', () => {
    const root = makeRepo();
    write(root, '.env.example');
    execFileSync('git', ['add', '.env.example'], { cwd: root });

    expect(verifyNoSecrets({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedPatterns: 5,
      violations: [],
    });
  });

  it.each(['.env', '.env.bak-20260830', 'tls/server.pem', '.gnupg/key', 'backups/db.sqlite'])(
    'fails for tracked secret-shaped path %s',
    (file) => {
      const root = makeRepo();
      write(root, file);
      execFileSync('git', ['add', file], { cwd: root });

      const result = verifyNoSecrets({ projectRoot: root, policy });
      expect(result.ok).toBe(false);
      expect(result.violations[0]).toMatchObject({ file, reason: 'tracked by git' });
    },
  );

  it('fails for untracked, unignored paths but accepts ignored paths', () => {
    const root = makeRepo();
    write(root, '.env');
    let result = verifyNoSecrets({ projectRoot: root, policy });
    expect(result.ok).toBe(false);
    expect(result.violations[0].reason).toContain('git add -A');

    appendFileSync(join(root, '.gitignore'), '/.env\n');
    result = verifyNoSecrets({ projectRoot: root, policy });
    expect(result.ok).toBe(true);
  });

  it('handles untracked filenames containing spaces without porcelain quote drift', () => {
    const root = makeRepo();
    write(root, 'private key.pem');

    expect(verifyNoSecrets({ projectRoot: root, policy }).violations[0].file)
      .toBe('private key.pem');
  });

  it('normalizes tracked and untracked paths relative to a nested --dir project root', () => {
    const repoRoot = makeRepo();
    const projectRoot = join(repoRoot, 'apps', 'app-a');

    // Tracked secret inside the nested project root: `git ls-files` already
    // resolves relative to cwd, so this exercises the pre-existing behavior.
    write(repoRoot, 'apps/app-a/tracked.pem');
    execFileSync('git', ['add', 'apps/app-a/tracked.pem'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'tracked secret'], { cwd: repoRoot });

    // Untracked secret inside the nested project root: `git status` paths are
    // repo-root-relative regardless of cwd, so this must be re-rooted onto
    // projectRoot to report `.env` (and to match `root-path` patterns).
    write(repoRoot, 'apps/app-a/.env');
    write(repoRoot, 'apps/app-a/backups/db.sqlite');
    // Untracked secret OUTSIDE the nested project root, elsewhere in the same
    // repo: must not be inspected at all.
    write(repoRoot, 'apps/app-b/.env');

    const result = verifyNoSecrets({ projectRoot, policy });

    expect(result.ok).toBe(false);
    const byFile = Object.fromEntries(result.violations.map((v) => [v.file, v]));
    expect(byFile['tracked.pem']).toMatchObject({ reason: 'tracked by git' });
    expect(byFile['.env']).toMatchObject({ reason: expect.stringContaining('git add -A') });
    expect(byFile['backups/db.sqlite']).toMatchObject({ reason: expect.stringContaining('git add -A') });
    expect(result.violations).toHaveLength(3);
  });

  it('detects an in-root untracked file whose name begins with two dots', () => {
    // `..secret` is not an escape above projectRoot — it's an ordinary
    // filename inside it — but a naive `relative.startsWith('..')` check
    // would mistake it for one and silently drop it from consideration.
    const root = makeRepo();
    write(root, '..secret');
    const dotdotPolicy = {
      patterns: [{ name: 'dotdot-prefixed', kind: 'basename-prefix', value: '..' }],
    };

    const result = verifyNoSecrets({ projectRoot: root, policy: dotdotPolicy });
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toMatchObject({
      file: '..secret',
      reason: expect.stringContaining('git add -A'),
    });
  });

  it('scopes the `git status` scan to the project root with a pathspec, not the whole repo', () => {
    const repoRoot = makeRepo();
    const projectRoot = join(repoRoot, 'apps', 'app-a');
    write(repoRoot, 'apps/app-a/.env');

    let statusArgs: string[] | undefined;
    const spyExecFileSync = (file: string, args: string[], options?: unknown) => {
      if (args[0] === 'status') statusArgs = args;
      return execFileSync(file, args, options as never);
    };

    verifyNoSecrets({ projectRoot, policy }, { execFileSync: spyExecFileSync });

    expect(statusArgs).toBeDefined();
    expect(statusArgs!.slice(-2)).toEqual(['--', '.']);
  });

  it('reports an actionable error instead of a raw ENOBUFS when git output overflows the buffer', () => {
    const root = makeRepo();

    const fakeExecFileSync = (file: string, args: string[], options?: unknown) => {
      if (args[0] === 'status') {
        const error = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
        throw error;
      }
      return execFileSync(file, args, options as never);
    };

    const result = verifyNoSecrets({ projectRoot: root, policy }, { execFileSync: fakeExecFileSync });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('cannot inspect git working tree');
    expect(result.errors[0]).toContain('produced more than');
    expect(result.errors[0]).toContain('fixed 64 MiB cap');
    expect(result.errors[0]).toContain('--dir');
  });
});

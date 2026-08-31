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
});

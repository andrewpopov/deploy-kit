import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(__filename);
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number };
const { resolveShipConfig } = require('../ship-config.js');
const { log } = require('../log.js') as Record<string, any>;

// PKG-318: a deploy ships the config of the commit it deploys, not the operator's (possibly stale) working tree.
// Real git throughout: the sha's config is read with `git show`, so a fake would prove nothing.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const baseConfig = { mode: 'local', projectDir: '/srv/app', appNames: ['app'], branch: 'master' };
const OLD_BACKUP = 'old-full-backup-to-drime-and-s3';
const NEW_BACKUP = 'new-local-only-backup';
const withHooks = (backup: string, extra: Record<string, unknown> = {}) => ({
  ...baseConfig, ...extra, hooks: { backup, migrate: 'run-migrations' },
});

function commitConfig(repo: string, config: unknown, subdir = '') {
  const dir = path.join(repo, subdir);
  mkdirSync(dir, { recursive: true });
  if (config === null) git(repo, 'rm', '-q', '-f', path.join(subdir, '.deploy-kit.config.json'));
  else writeFileSync(path.join(dir, '.deploy-kit.config.json'), JSON.stringify(config));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'config');
  return git(repo, 'rev-parse', 'HEAD');
}

// origin holds `older` then `newer` (also branch `green`); `work` is a clone left at `older`.
function stale(older: unknown, newer: unknown, { subdir = '' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'dk-ship-config-'));
  roots.push(root);
  const origin = path.join(root, 'origin');
  git(root, 'init', '-q', '-b', 'master', origin);
  const olderSha = commitConfig(origin, older, subdir);
  git(root, 'clone', '-q', origin, path.join(root, 'work'));
  const newerSha = commitConfig(origin, newer, subdir);
  git(origin, 'branch', 'green', newerSha);
  return { work: path.join(root, 'work', subdir), olderSha, newerSha };
}

function captureLog() {
  const lines: string[] = [];
  for (const m of ['error', 'success', 'info', 'step', 'header', 'warning', 'divider']) {
    vi.spyOn(log, m).mockImplementation((msg: string) => { lines.push(String(msg)); });
  }
  return lines;
}

const NOTICE = (sha: string) => `deploy-kit: using .deploy-kit.config.json from ${sha.slice(0, 8)} (the working tree differs)`;
const loadWorking = (cwd: string, override = {}) => require('../config.js').loadConfig({ cwd, override });

describe('PKG-318: config comes from the sha being shipped', () => {
  it('CANARY stale-hook: the working tree has the old backup hook, --sha has the new one -> the plan uses the new one and prints the notice', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    const lines = captureLog();
    git(work, 'fetch', '-q', 'origin');
    const code = cli.run(['deploy', '--sha', newerSha, '--dry-run'], { cwd: work, env: {} });
    const out = lines.join('\n');
    expect(code).toBe(0);
    expect(out).toContain(NOTICE(newerSha));
    expect(out).toContain(NEW_BACKUP);
    expect(out).not.toContain(OLD_BACKUP);
  });

  it('CANARY no-notice-when-identical: an identical config prints no notice', () => {
    const { work, newerSha } = stale(withHooks(NEW_BACKUP), withHooks(NEW_BACKUP));
    const lines = captureLog();
    git(work, 'fetch', '-q', 'origin');
    expect(cli.run(['deploy', '--sha', newerSha, '--dry-run'], { cwd: work, env: {} })).toBe(0);
    expect(lines.join('\n')).not.toContain('using .deploy-kit.config.json');
  });

  it('CANARY verified-tip: requireVerifiedRef resolves green, ships its config and pins options.sha to that tip', () => {
    const verified = { requireVerifiedRef: 'green' };
    const { work, newerSha } = stale(withHooks(OLD_BACKUP, verified), withHooks(NEW_BACKUP, verified));
    const lines = captureLog();
    const result = resolveShipConfig({ config: loadWorking(work), options: {}, override: {}, cwd: work });
    expect(result.config.hooks.backup).toBe(NEW_BACKUP);
    expect(result.options.sha).toBe(newerSha);
    expect(lines.join('\n')).toContain(NOTICE(newerSha));
  });

  it('CANARY fail-closed-no-config: a sha without .deploy-kit.config.json is refused, naming the file', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), null);
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    expect(() => resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha }, override: {}, cwd: work,
    })).toThrow(/has no \.deploy-kit\.config\.json/);
  });

  it('CANARY bootstrap-requireVerifiedRef: the sha changes requireVerifiedRef -> refused, naming the key', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP, { requireVerifiedRef: 'green' }));
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    expect(() => resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha }, override: {}, cwd: work,
    })).toThrow(/"requireVerifiedRef" in the working tree's/);
  });

  it('CANARY bootstrap-host: the sha changes host -> refused, naming the key', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP, { host: 'old@host' }), withHooks(NEW_BACKUP, { host: 'new@host' }));
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    expect(() => resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha }, override: {}, cwd: work,
    })).toThrow(/"host" in the working tree's/);
  });

  it('reads the config from the checkout subdirectory it was loaded from', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP), { subdir: 'apps/web' });
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    const result = resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha }, override: {}, cwd: work,
    });
    expect(result.config.hooks.backup).toBe(NEW_BACKUP);
  });

  it('a real (non dry-run) deploy of a sha missing locally fetches it before reading', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    captureLog();
    const result = resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha }, override: {}, cwd: work,
    });
    expect(result.config.hooks.backup).toBe(NEW_BACKUP);
  });

  it('CANARY on-host-stale-checkout: deploy-kit run inside the host\'s old checkout (mode local) with a --sha it has never fetched ships the new hooks.backup', () => {
    const { work, olderSha, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    const lines = captureLog();
    expect(git(work, 'cat-file', '-t', olderSha)).toBe('commit');
    expect(() => git(work, 'cat-file', '-e', `${newerSha}^{commit}`)).toThrow();
    const result = resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha }, override: {}, cwd: work,
    });
    expect(result.config.hooks.backup).toBe(NEW_BACKUP);
    expect(result.options.sha).toBe(newerSha);
    expect(lines).toContain(NOTICE(newerSha));
  });

  it('a dry run never fetches: a sha missing locally plans from the working tree with a warning', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    const lines = captureLog();
    const result = resolveShipConfig({
      config: loadWorking(work), options: { sha: newerSha, dryRun: true }, override: {}, cwd: work,
    });
    expect(result.config.hooks.backup).toBe(OLD_BACKUP);
    expect(lines.join('\n')).toContain('planning with the working-tree');
  });
});

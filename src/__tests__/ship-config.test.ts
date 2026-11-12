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
const kit = require('../index.js') as any;
const release = require('../release.js');
const { onHostDeploy } = require('../on-host/operator.js');

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


// ---- the shared boundary: API callers, the late (branch tip) path, release layout, --on-host ----
const OLD_INSTALL = 'old-install-hook';
const NEW_INSTALL = 'new-install-hook';
const RELEASE_LAYOUT = {
  type: 'releases', keepReleases: 3, runningShaCommand: 'echo running',
};
const pipelineConfig = (install: string, extra: Record<string, unknown> = {}) => ({
  host: 'app@host', mode: 'ssh', projectDir: '/srv/app', appNames: ['app'], branch: 'master', ecosystemFile: 'ecosystem.config.js',
  hooks: { install }, ...extra,
});

// A fake target good enough to carry a legacy or release deploy past install. `shown` answers `git show <sha>:<config>`.
function pipelineRuntime(sha: string, shown = '') {
  const calls: string[] = [];
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (/\bshow\b/.test(cmd) && cmd.includes('.deploy-kit.config.json')) return shown;
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP') || cmd.includes('df -Pk')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('.prev-sha')) return sha;
    if (cmd.includes('symbolic-ref')) return 'master';
    if (cmd.includes('rev-parse')) return sha;
    if (cmd.includes('readlink -f')) return '/canonical';
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: 'online', restart_time: 5 } }]);
    if (cmd.includes('readlink ') && cmd.includes('/current')) return 'releases/deadbee-20260709T090000Z';
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return 'releases/cafe123-20260708T090000Z';
    if (cmd.includes('curl')) return '200';
    return '';
  };
  return { calls, ctx: { runtime: { execFileSync }, sleep: () => {} } };
}
const runDeploy = (fn: Function, config: unknown, options: Record<string, unknown>, rt: ReturnType<typeof pipelineRuntime>) => {
  try { fn(config, { autoCut: false, ...options }, rt.ctx); } catch { /* the stream up to install is what is asserted */ }
  return rt.calls.join('\n');
};
const installs = (stream: string) => ({ old: stream.includes(OLD_INSTALL), new: stream.includes(NEW_INSTALL) });

describe.each([
  ['legacy', kit.deploy, {}],
  ['release', release.deployRelease, { layout: RELEASE_LAYOUT }],
])('PKG-318 boundary: %s pipeline', (_name, fn, extra) => {
  it('CANARY direct-api: deploy(loadConfig(), { sha }) runs the sha\'s hooks, not the checkout\'s', () => {
    const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, extra));
    const lines = captureLog();
    git(work, 'fetch', '-q', 'origin');
    const stream = runDeploy(fn, loadWorking(work), { sha: newerSha }, pipelineRuntime(newerSha));
    expect(installs(stream)).toEqual({ old: false, new: true });
    expect(lines.filter((l) => l === NOTICE(newerSha))).toHaveLength(1);
  });

  it('CANARY late-branch-tip: no sha, the target resolves one, its config is read from the target and used', () => {
    const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, extra));
    const lines = captureLog();
    const stream = runDeploy(fn, loadWorking(work), {}, pipelineRuntime(newerSha, JSON.stringify(pipelineConfig(NEW_INSTALL, extra))));
    expect(installs(stream)).toEqual({ old: false, new: true });
    expect(lines).toContain(NOTICE(newerSha));
  });

  it('CANARY late-bootstrap: a target config that moves the host is refused before install', () => {
    const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, extra));
    captureLog();
    const rt = pipelineRuntime(newerSha, JSON.stringify(pipelineConfig(NEW_INSTALL, { ...extra, host: 'other@host' })));
    expect(() => fn(loadWorking(work), { autoCut: false }, rt.ctx)).toThrow(/"host" in the working tree's/);
    expect(rt.calls.join('\n')).not.toContain(NEW_INSTALL);
  });

  it('an inline config (no file behind it) is left alone: nothing to re-read', () => {
    const rt = pipelineRuntime('a'.repeat(40));
    const inline = kit.mergeConfig(kit.DEFAULT_CONFIG, pipelineConfig(OLD_INSTALL, extra));
    expect(installs(runDeploy(fn, inline, { sha: 'a'.repeat(40) }, rt))).toEqual({ old: true, new: false });
  });
});

describe('PKG-318 --on-host', () => {
  const PREFLIGHT = {
    DK_USER: 'dkapp', DK_UID: '1000', DK_LINGER: 'yes', DK_USER_MANAGER: 'yes', DK_NODE: '/usr/bin/node', DK_NODE_MAJOR: '24', DK_ACTIVE_UNITS: '0',
    DK_SHELL: '/bin/bash', DK_GID: '1000', DK_GROUPS: '1000', DK_GROUP_NAMES: 'dkapp', DK_MANAGER_GROUPS: '\t1000', DK_UMASK: '0027', DK_OOM: '100',
    DK_PATH: '/usr/bin', DK_HOME: '/srv/dkapp', DK_LOGNAME: 'dkapp', ENV_LANG: 'C.UTF-8', ENVABSENT_PM2_HOME: '1', DK_END: '1',
  } as Record<string, string>;
  const hex = (v: string) => Buffer.from(v, 'utf8').toString('hex');
  function scriptedHost() {
    const uploads: Buffer[] = [];
    const execFileSync = (_file: string, args: string[], opts: { input?: Buffer }) => {
      const cmd = args[args.length - 1];
      if (cmd === 'sh -se') return `${Object.entries(PREFLIGHT).map(([k, v]) => `${k}=${hex(v)}`).join('\n')}\n`;
      if (cmd.includes('dk-run-exists')) return 'dk-run-free\n';
      if (cmd.includes('tar -x')) uploads.push(opts.input as Buffer);
      return '';
    };
    return { uploads, runtime: { execFileSync } };
  }
  const deploy = (work: string, sha: string, host: ReturnType<typeof scriptedHost>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dk-ship-onhost-'));
    roots.push(dir);
    return onHostDeploy(loadWorking(work), { sha, autoCut: false }, {
      runtime: host.runtime, log: { info: () => {}, warning: () => {}, error: () => {}, success: () => {} }, receiptsPath: path.join(dir, 'r.jsonl'), tmpRoot: dir,
      gitHead: () => 'c'.repeat(40), now: () => new Date('2026-09-30T12:00:00.000Z'), randomHex: () => 'deadbeef', attach: () => 0,
    });
  };
  const bundledConfig = (host: ReturnType<typeof scriptedHost>) => JSON.parse(execFileSync('tar', ['-xOf', '-', 'config.json'], { input: host.uploads[0], encoding: 'utf8' }));

  it('CANARY on-host-bundle: the config bundled for the host is the sha\'s, not the working tree\'s', () => {
    const cfg = (install: string) => pipelineConfig(install, { layout: RELEASE_LAYOUT });
    const { work, newerSha } = stale(cfg(OLD_INSTALL), cfg(NEW_INSTALL));
    git(work, 'fetch', '-q', 'origin');
    const host = scriptedHost();
    expect(deploy(work, newerSha, host)).toBe(0);
    expect(bundledConfig(host).hooks.install).toBe(NEW_INSTALL);
  });

  it('CANARY on-host-bootstrap: a sha that moves the host is refused before anything is uploaded', () => {
    const cfg = (install: string, over = {}) => pipelineConfig(install, { layout: RELEASE_LAYOUT, ...over });
    const { work, newerSha } = stale(cfg(OLD_INSTALL), cfg(NEW_INSTALL, { host: 'other@host' }));
    git(work, 'fetch', '-q', 'origin');
    const host = scriptedHost();
    expect(deploy(work, newerSha, host)).toBe(1);
    expect(host.uploads).toHaveLength(0);
  });
});

describe('PKG-318 sources of the sha', () => {
  it('CANARY narrow-refspec: a checkout that only tracks another branch still fetches the exact sha', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    git(work, 'config', 'remote.origin.fetch', '+refs/heads/nothing:refs/remotes/origin/nothing');
    captureLog();
    const result = resolveShipConfig({ config: loadWorking(work), options: { sha: newerSha } });
    expect(result.config.hooks.backup).toBe(NEW_BACKUP);
  });

  it('CANARY fetch-failure-is-not-missing-config: an unfetchable sha reports the fetch, not the file', () => {
    const { work } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    captureLog();
    const act = () => resolveShipConfig({ config: loadWorking(work), options: { sha: 'f'.repeat(40) } });
    expect(act).toThrow(/could not be fetched/);
    expect(act).not.toThrow(/has no \.deploy-kit\.config\.json/);
  });

  it('CANARY remote-names: the controller\'s remote is called upstream, the target\'s config says origin', () => {
    const verified = { requireVerifiedRef: 'green' };
    const { work, newerSha } = stale(withHooks(OLD_BACKUP, verified), withHooks(NEW_BACKUP, verified));
    git(work, 'remote', 'rename', 'origin', 'upstream');
    captureLog();
    const result = resolveShipConfig({ config: loadWorking(work), options: {} });
    expect(result.options.sha).toBe(newerSha);
    expect(result.config.hooks.backup).toBe(NEW_BACKUP);
  });

  it('CANARY dry-run-no-config: a dry run against a local commit with no config fails closed like a real run', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), null);
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    expect(() => resolveShipConfig({ config: loadWorking(work), options: { sha: newerSha, dryRun: true } })).toThrow(/has no \.deploy-kit\.config\.json/);
  });
});

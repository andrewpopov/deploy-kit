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
const { resolveShipConfig, assertConfigAtCut } = require('../ship-config.js');
const { log } = require('../log.js') as Record<string, any>;
const kit = require('../index.js') as any;
const release = require('../release.js');
const { onHostDeploy, onHostRecover } = require('../on-host/operator.js');
const { PIN_CHECK_COMMAND } = require('../pin-gate.js');

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

// A fake target good enough to carry a legacy or release deploy past install. `movedTip` makes the target's branch tip differ from `sha`.
function pipelineRuntime(sha: string, movedTip = '', autoCutTipReads = 0) {
  const calls: string[] = [];
  let remoteTipReads = 0;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cmd.includes('ls-remote --symref')) return `ref: refs/heads/master\tHEAD\n${sha}\tHEAD\n`;
    if (/MERGE_HEAD|rebase-merge|rebase-apply|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG/.test(cmd)) return 'none\n';
    if (cmd.includes('@{u}')) return 'origin/master\n';
    if (cmd.includes('remote get-url --push')) return 'git@github.com:andrewpopov/demo.git\n';
    if (cmd.includes('gh repo view')) return 'andrewpopov/demo\n';
    if (movedTip && cmd.includes("rev-parse 'origin'/'master'")) { remoteTipReads += 1; return remoteTipReads <= autoCutTipReads ? sha : movedTip; }
    if (movedTip && cmd.includes("rev-parse refs/heads/'master'")) return movedTip;
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

  const withCheck = (install: string, command: string) => pipelineConfig(install, { ...extra, preDeployChecks: [{ name: 'chk', command }] });

  it('CANARY branch-tip: no sha, the branch tip is resolved first and pinned; install AND preDeployChecks come from its config', () => {
    const { work, newerSha } = stale(withCheck(OLD_INSTALL, 'old-check'), withCheck(NEW_INSTALL, 'new-check'));
    const lines = captureLog();
    const stream = runDeploy(fn, loadWorking(work), {}, pipelineRuntime(newerSha));
    expect(installs(stream)).toEqual({ old: false, new: true });
    expect(stream).toContain('new-check');
    expect(stream).not.toContain('old-check');
    expect(lines).toContain(NOTICE(newerSha));
  });

  it('CANARY branch-tip-bootstrap: a tip config that moves the host is refused before any target command', () => {
    const { work } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, { ...extra, host: 'other@host' }));
    captureLog();
    const rt = pipelineRuntime('a'.repeat(40));
    expect(() => fn(loadWorking(work), { autoCut: false }, rt.ctx)).toThrow(/"host" in the working tree's/);
    expect(rt.calls).toEqual([]);
  });

  it('CANARY tip-moved: the target sees a different branch tip than the one the config was read from -> refused', () => {
    const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, extra));
    captureLog();
    const rt = pipelineRuntime(newerSha, 'b'.repeat(40));
    expect(() => fn(loadWorking(work), { autoCut: false }, rt.ctx)).toThrow(/moved to bbbbbbbbbbbb/);
    expect(rt.calls.join('\n')).not.toContain(NEW_INSTALL);
  });

  it('CANARY verify-pins: verifyPins taken from the sha decides whether the pin gate runs', () => {
    if (_name === 'release') return;
    const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, { ...extra, verifyPins: false }));
    captureLog();
    const stream = runDeploy(fn, loadWorking(work), {}, pipelineRuntime(newerSha));
    expect(stream).toContain(NEW_INSTALL);
    expect(stream).not.toContain(PIN_CHECK_COMMAND);
  });

  describe('auto-cut that may run but has nothing to cut', () => {
    const fakeKit = { collectFragments: () => [], resolvePaths: () => ({ rootDir: '/unused' }) };
    function prepare(movedTip = '') {
      const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, extra), pipelineConfig(NEW_INSTALL, extra));
      writeFileSync(path.join(work, 'release-kit.config.js'), 'module.exports = {};\n');
      const rt = pipelineRuntime(newerSha, movedTip, 1);
      Object.assign(rt.ctx, { resolve: () => 'fake-release-kit', requireModule: (id: string) => (id === 'fake-release-kit' ? fakeKit : {}) });
      return { work, newerSha, rt };
    }

    it('CANARY autocut-zero-fragments: the tip it read the config from ships, with that config', () => {
      const { work, newerSha, rt } = prepare();
      const lines = captureLog();
      const stream = runDeploy(fn, loadWorking(work), { autoCut: undefined, projectRoot: work }, rt);
      expect(installs(stream)).toEqual({ old: false, new: true });
      expect(lines).toContain(NOTICE(newerSha));
    });

    it('CANARY autocut-zero-fragments-tip-moved: the tip moved after the config was read -> refused, not deployed with the old config', () => {
      const { work, rt } = prepare('b'.repeat(40));
      captureLog();
      expect(() => fn(loadWorking(work), { autoCut: undefined, projectRoot: work }, rt.ctx)).toThrow(/moved to bbbbbbbbbbbb/);
      expect(rt.calls.join('\n')).not.toContain(NEW_INSTALL);
    });
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

describe('PKG-318 protections and validation come from the shipped config', () => {
  it('CANARY migration-validation: preflight sees the sha\'s migrate hook (and refuses a missing backup hook)', () => {
    const { work, newerSha } = stale(
      pipelineConfig(OLD_INSTALL, { layout: RELEASE_LAYOUT }),
      pipelineConfig(NEW_INSTALL, { layout: RELEASE_LAYOUT, hooks: { install: NEW_INSTALL, migrate: 'run-migrations' } }),
    );
    captureLog();
    const rt = pipelineRuntime(newerSha);
    expect(() => release.deployRelease(loadWorking(work), { autoCut: false, sha: newerSha }, rt.ctx)).toThrow(/requires a `backup` hook/);
  });

  it('CANARY transition-authority: a transitionAuthority added at the sha is enforced by the legacy entry point', () => {
    const { work, newerSha } = stale(
      pipelineConfig(OLD_INSTALL),
      pipelineConfig(NEW_INSTALL, { transitionAuthority: { command: 'echo authority', scope: 'app' } }),
    );
    captureLog();
    expect(() => kit.deploy(loadWorking(work), { autoCut: false, sha: newerSha }, pipelineRuntime(newerSha).ctx)).toThrow(/does not support a configured transitionAuthority/);
  });

  it('CANARY wrapped-fs: a config read through a wrapped fs is still stamped and still re-read from the sha', () => {
    const { work, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    const config = require('../config.js').loadConfig({ cwd: work, fsImpl: { ...require('fs') } });
    expect(Object.getOwnPropertySymbols(config)).toContain(Symbol.for('deploy-kit.configOrigin'));
    expect(resolveShipConfig({ config, options: { sha: newerSha } }).config.hooks.backup).toBe(NEW_BACKUP);
  });

  it('CANARY on-host-recover: recover names no commit, so its config is bundled as loaded (no resolution against the zero sha)', () => {
    const { work } = stale(pipelineConfig(OLD_INSTALL, { layout: RELEASE_LAYOUT }), pipelineConfig(NEW_INSTALL, { layout: RELEASE_LAYOUT }));
    captureLog();
    const dir = mkdtempSync(path.join(tmpdir(), 'dk-ship-recover-'));
    roots.push(dir);
    const uploads: Buffer[] = [];
    const hex = (v: string) => Buffer.from(v, 'utf8').toString('hex');
    const pre: Record<string, string> = {
      DK_USER: 'dkapp', DK_UID: '1000', DK_LINGER: 'yes', DK_USER_MANAGER: 'yes', DK_NODE: '/usr/bin/node', DK_NODE_MAJOR: '24', DK_ACTIVE_UNITS: '0',
      DK_SHELL: '/bin/bash', DK_GID: '1000', DK_GROUPS: '1000', DK_GROUP_NAMES: 'dkapp', DK_MANAGER_GROUPS: '\t1000', DK_UMASK: '0027', DK_OOM: '100',
      DK_PATH: '/usr/bin', DK_HOME: '/srv/dkapp', DK_LOGNAME: 'dkapp', ENV_LANG: 'C.UTF-8', ENVABSENT_PM2_HOME: '1', DK_END: '1',
    };
    const hostExec = (_f: string, args: string[], opts: { input?: Buffer }) => {
      const cmd = args[args.length - 1];
      if (cmd === 'sh -se') return `${Object.entries(pre).map(([k, v]) => `${k}=${hex(v)}`).join('\n')}\n`;
      if (cmd.includes('dk-run-exists')) return 'dk-run-free\n';
      if (cmd.includes('tar -x')) uploads.push(opts.input as Buffer);
      return '';
    };
    const quiet = { info: () => {}, warning: () => {}, error: () => {}, success: () => {} };
    const code = onHostRecover(loadWorking(work), {
      request: 'req-1', epoch: '0', notAfter: '1790000000', expectReservation: '{"state":"none","runId":null,"gen":0}', parentRun: '20261023T101500Z-0123456789ab-0badcafe',
    }, {
      runtime: { execFileSync: hostExec }, log: quiet, receiptsPath: path.join(dir, 'r.jsonl'), tmpRoot: dir, gitHead: () => 'c'.repeat(40),
      now: () => new Date('2026-09-30T12:00:00.000Z'), randomHex: () => 'deadbeef', attach: () => 0,
    });
    expect(code).toBe(0);
    expect(JSON.parse(execFileSync('tar', ['-xOf', '-', 'config.json'], { input: uploads[0], encoding: 'utf8' })).hooks.install).toBe(OLD_INSTALL);
  });
});

describe('PKG-318 edges', () => {
  it('CANARY not-a-git-checkout: a real deploy from a non-git directory is refused; only a dry run may plan with the file as is', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dk-ship-nogit-'));
    roots.push(dir);
    writeFileSync(path.join(dir, '.deploy-kit.config.json'), JSON.stringify(withHooks(OLD_BACKUP)));
    const lines = captureLog();
    const config = loadWorking(dir);
    expect(() => resolveShipConfig({ config, options: { sha: 'a'.repeat(40) } })).toThrow(/is not a git checkout/);
    expect(() => resolveShipConfig({ config, options: {} })).toThrow(/Run deploy-kit from a checkout/);
    const planned = resolveShipConfig({ config, options: { sha: 'a'.repeat(40), dryRun: true } });
    expect(planned.config.hooks.backup).toBe(OLD_BACKUP);
    expect(lines.join('\n')).toContain('is not a git checkout');
  });

  it('CANARY auto-cut-config: a cut that changed the config the deploy adopted from the tip is refused', () => {
    const { work, olderSha, newerSha } = stale(withHooks(OLD_BACKUP), withHooks(NEW_BACKUP));
    captureLog();
    git(work, 'fetch', '-q', 'origin');
    const adopted = resolveShipConfig({ config: loadWorking(work), options: { sha: newerSha } }).config;
    expect(() => assertConfigAtCut(adopted, newerSha)).not.toThrow();
    expect(() => assertConfigAtCut(adopted, olderSha)).toThrow(/auto-cut's release .* changed \.deploy-kit\.config\.json/);
  });
});

describe('PKG-318 one project root', () => {
  const verified = { requireVerifiedRef: 'green' };
  function appWithReleaseKit() {
    const { work, newerSha } = stale(pipelineConfig(OLD_INSTALL, verified), pipelineConfig(NEW_INSTALL, verified));
    writeFileSync(path.join(work, 'release-kit.config.js'), 'module.exports = {};\n');
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'dk-ship-elsewhere-'));
    roots.push(elsewhere);
    return { work, newerSha, elsewhere };
  }

  it('CANARY project-root: called with a projectRoot elsewhere, the app\'s own root decides auto-cut, and the stale file never ships', () => {
    const { work, newerSha, elsewhere } = appWithReleaseKit();
    captureLog();
    const rt = pipelineRuntime(newerSha);
    expect(() => kit.deploy(loadWorking(work), { projectRoot: elsewhere }, rt.ctx)).toThrow(/auto-cut would run/);
    expect(rt.calls.join('\n')).not.toContain(OLD_INSTALL);
  });

  it('CANARY verified-adopts-when-auto-cut-predicted: the verified tip is pinned and adopted, with the app\'s root', () => {
    const { work, newerSha, elsewhere } = appWithReleaseKit();
    captureLog();
    const result = resolveShipConfig({ config: loadWorking(work), options: { projectRoot: elsewhere } });
    expect(result.config.hooks.install).toBe(NEW_INSTALL);
    expect(result.options.sha).toBe(newerSha);
    expect(result.options.projectRoot).toBe(work);
  });
});

describe('PKG-318 on-host argument guards run on the operator\'s own options', () => {
  it.each([
    ['--branch override', ['deploy', '--on-host', '--branch', 'feature/x', '--no-auto-cut'], 'ONHOST_BRANCH'],
    ['no explicit --sha', ['deploy', '--on-host', '--no-auto-cut'], 'ONHOST_NO_SHA'],
  ])('CANARY on-host-guards: %s is refused with %s, not rewritten into a pinned tip', (_name, argv, code) => {
    const cfg = pipelineConfig(NEW_INSTALL, { layout: RELEASE_LAYOUT });
    const { work } = stale(cfg, cfg);
    const lines = captureLog();
    expect(cli.run(argv, { cwd: work, env: {} })).toBe(1);
    expect(lines.join('\n')).toContain(`${code}:`);
  });
});

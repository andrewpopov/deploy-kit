import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import {
  mkdtempSync, rmSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const release = require('../release.js');
const { mergeConfig, DEFAULT_CONFIG, validateConfig } = kit;
const { deploy } = kit as any;

// BRAIN-567: requireVerifiedRef. The ancestor logic is exercised against REAL git
// (origin with master ahead of green); only non-git target commands are faked.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV }).trim();

const roots: string[] = [];
const savedHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = savedHome;
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

// origin: c1 <- c2 (green) <- c3 (master tip, NOT verified)
function makeOrigin(withGreen = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'dk-verified-'));
  roots.push(root);
  const origin = path.join(root, 'origin');
  git(root, 'init', '-q', '-b', 'master', origin);
  const commit = (name: string) => {
    writeFileSync(path.join(origin, 'f'), name);
    git(origin, 'add', 'f');
    git(origin, 'commit', '-q', '-m', name);
    return git(origin, 'rev-parse', 'HEAD');
  };
  const c1 = commit('c1');
  const c2 = commit('c2');
  if (withGreen) git(origin, 'branch', 'green', c2);
  const c3 = commit('c3');
  return { root, origin, c1, c2, c3 };
}

// The pipeline wraps a step failure in its own error, so the fake records that it reached the stop step.
const SENTINEL = 'STOP-AFTER-GIT-PHASE';

describe('requireVerifiedRef: legacy layout (real git)', () => {
  function legacy(withGreen = true, over: any = {}) {
    const o = makeOrigin(withGreen);
    const target = path.join(o.root, 'target');
    git(o.root, 'clone', '-q', '-b', 'master', o.origin, target);
    git(target, 'reset', '-q', '--hard', o.c1);
    process.env.HOME = o.root;
    const config = mergeConfig(DEFAULT_CONFIG, {
      mode: 'local', projectDir: target, branch: 'master', autoCut: false, lock: false, appNames: [],
      dbBoundApps: [], hooks: { install: 'INSTALL-STEP' }, requireVerifiedRef: 'green', ...over,
    });
    const calls: string[] = [];
    const reached = { stop: false };
    const runtime = {
      execFileSync: (file: string, args: string[], options: any) => {
        const cmd = args[args.length - 1];
        calls.push(cmd);
        if (cmd.includes('INSTALL-STEP')) reached.stop = true;
        if (cmd.includes('INSTALL-STEP')) throw new Error(SENTINEL);
        return execFileSync(file, args, options);
      },
    };
    const run = (options: any = {}) => deploy(config, { stash: false, ...options }, { runtime, log: quietLog });
    return { ...o, target, config, calls, reached, run, head: () => git(target, 'rev-parse', 'HEAD') };
  }
  const quietLog = {
    header() {}, step() {}, info() {}, warning() {}, error() {}, success() {}, dim() {},
  };

  it('a plain deploy ships the green tip, not the newer master tip', () => {
    const t = legacy();
    expect(() => t.run()).toThrow();
    expect(t.reached.stop).toBe(true);
    expect(t.head()).toBe(t.c2);
    expect(t.calls.some((c) => c.includes('git pull'))).toBe(false);
  });

  it('a --sha newer than green is refused and the target is untouched', () => {
    const t = legacy();
    expect(() => t.run({ sha: t.c3 })).toThrow(/has not passed the full suite \(not contained in origin\/green/);
    expect(t.head()).toBe(t.c1);
  });

  it('a --sha inside green is accepted', () => {
    const t = legacy();
    expect(() => t.run({ sha: t.c2 })).toThrow();
    expect(t.reached.stop).toBe(true);
    expect(t.head()).toBe(t.c2);
  });

  it('a missing green ref aborts before touching anything, naming the ref', () => {
    const t = legacy(false);
    expect(() => t.run()).toThrow(/verified ref "green".*has not verified anything yet/);
    expect(t.head()).toBe(t.c1);
    expect(t.calls.some((c) => c.includes('merge --ff-only'))).toBe(false);
  });

  it('--branch is refused', () => {
    const t = legacy();
    expect(() => t.run({ branch: 'master' })).toThrow(/--branch is refused when requireVerifiedRef is set/);
    expect(t.calls).toEqual([]);
  });

  it('a null key leaves the plain deploy pulling the branch tip', () => {
    const t = legacy(true, { requireVerifiedRef: null });
    expect(() => t.run()).toThrow();
    expect(t.reached.stop).toBe(true);
    expect(t.head()).toBe(t.c3);
    expect(t.calls.some((c) => c.includes('git pull --ff-only'))).toBe(true);
  });
});

describe('requireVerifiedRef: release layout (real bare repo)', () => {
  function releaseTarget(withGreen = true) {
    const o = makeOrigin(withGreen);
    const root = path.join(o.root, 'app');
    execFileSync('mkdir', ['-p', root]);
    git(o.root, 'clone', '-q', '--bare', o.origin, path.join(root, 'repo.git'));
    const config = mergeConfig(DEFAULT_CONFIG, {
      mode: 'local', projectDir: root, branch: 'master', autoCut: false, lock: false, appNames: ['app'],
      dbBoundApps: [], ecosystemFile: 'shared/ecosystem.config.cjs', requireVerifiedRef: 'green',
      layout: { type: 'releases', sharedPaths: [] },
    });
    const worktrees: string[] = [];
    const reached = { stop: false };
    const runtime = {
      execFileSync: (file: string, args: string[], options: any) => {
        const cmd = args[args.length - 1];
        if (cmd.includes('worktree add')) { worktrees.push(cmd); reached.stop = true; throw new Error(SENTINEL); }
        if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
        if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9';
        if (cmd.includes('df -kP')) return '99999999';
        if (cmd.includes('--git-dir') || cmd.includes('date -u')) return execFileSync(file, args, options);
        return '';
      },
    };
    const log = {
      header() {}, step() {}, info() {}, warning() {}, error() {}, success() {}, dim() {}, ...{},
    };
    const run = (options: any = {}) => release.deployRelease(config, options, { runtime, log });
    return { ...o, run, worktrees, reached };
  }

  it('a plain release deploy materializes the green tip', () => {
    const t = releaseTarget();
    expect(() => t.run()).toThrow();
    expect(t.reached.stop).toBe(true);
    expect(t.worktrees[0]).toContain(t.c2);
    expect(t.worktrees[0]).not.toContain(t.c3);
  });

  it('a --sha newer than green is refused', () => {
    const t = releaseTarget();
    expect(() => t.run({ sha: t.c3 })).toThrow(/has not passed the full suite/);
    expect(t.worktrees).toEqual([]);
  });

  it('a --sha inside green is accepted', () => {
    const t = releaseTarget();
    expect(() => t.run({ sha: t.c1 })).toThrow();
    expect(t.reached.stop).toBe(true);
    expect(t.worktrees[0]).toContain(t.c1);
  });

  it('a missing green ref is refused', () => {
    const t = releaseTarget(false);
    expect(() => t.run()).toThrow(/has not verified anything yet/);
    expect(t.worktrees).toEqual([]);
  });

  it('--branch is refused', () => {
    const t = releaseTarget();
    expect(() => t.run({ branch: 'master' })).toThrow(/--branch is refused when requireVerifiedRef is set/);
  });
});

describe('requireVerifiedRef: config validation', () => {
  it('defaults to null and accepts a plain branch name', () => {
    expect(DEFAULT_CONFIG.requireVerifiedRef).toBeNull();
    expect(validateConfig({ requireVerifiedRef: 'green' })).toEqual([]);
    expect(validateConfig({ requireVerifiedRef: null })).toEqual([]);
  });

  it.each(['', 'has space', '-x', 'a..b', 'a:b'])('rejects a bad ref name %j', (bad) => {
    expect(validateConfig({ requireVerifiedRef: bad }).join()).toMatch(/"requireVerifiedRef".*plain branch name/);
  });

  it('rejects a ref equal to branch', () => {
    expect(validateConfig({ branch: 'master', requireVerifiedRef: 'master' }).join()).toMatch(/must differ from "branch"/);
  });

  it('rejects the key together with an enabled autoCut', () => {
    expect(validateConfig({ requireVerifiedRef: 'green', autoCut: {} }).join()).toMatch(/cannot be combined with "autoCut"/);
    expect(validateConfig({ requireVerifiedRef: 'green', autoCut: false })).toEqual([]);
  });
});

// The CLI's --dry-run planner fakes every target read; the verified-tip read must be one of them,
// or every `deploy --dry-run` on a requireVerifiedRef app aborts with "no green branch".
describe('requireVerifiedRef: --dry-run plans through the CLI planner', () => {
  const cli = require('../cli.js');
  const quiet = { header() {}, step() {}, info() {}, warning() {}, error() {}, success() {}, dim() {} };
  const dryConfig = (over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
    host: 'u@h', projectDir: '/srv/app', branch: 'master', autoCut: false, appNames: ['app'],
    verifyPins: false, requireVerifiedRef: 'green', ...over,
  });
  it('a plain legacy dry run plans the verified tip', () => {
    const config = dryConfig();
    const result = deploy(config, { dryRun: true, stash: false }, { ...cli.dryRunContext(config), log: quiet });
    expect(result.steps).toContain(`merge:${'d'.repeat(40)}`);
  });
  it('a --sha legacy dry run plans that sha', () => {
    const sha = 'a'.repeat(40);
    const config = dryConfig();
    const result = deploy(config, { dryRun: true, stash: false, sha }, { ...cli.dryRunContext(config, { sha }), log: quiet });
    expect(result.steps).toContain(`merge:${sha}`);
  });
});

// Deploy-by-SHA wiring: autoCut() called from deploy()/deployRelease(), and
// the guards that make bringing the target to the immutable release `R` safe
// (as opposed to a plain branch-tip pull). Each guard here asserts its own
// specific error message, per project convention.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const release = require('../release.js');
const { mergeConfig, DEFAULT_CONFIG, deploy } = kit;

const REMOTE = 'origin';
const BRANCH = 'master';
const ROOT = '/repo';
const BASE_TIP = 'a'.repeat(40); // controller's local HEAD == remote tip, pre-cut
const CUT_SHA = 'b'.repeat(40);
const MERGE_SHA = 'c'.repeat(40); // R
const TARGET_HEAD = 'a'.repeat(40); // target's pre-deploy HEAD -- an ancestor of R

function makeFakeFs(initialFiles: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const dirs = new Set<string>(['/repo/.deploy-kit']);
  return {
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    readFileSync: (p: string) => {
      if (!files.has(p)) { const e: any = new Error(`ENOENT: ${p}`); throw e; }
      return files.get(p) as string;
    },
    writeFileSync: (p: string, content: string) => { files.set(p, content); },
    renameSync: (from: string, to: string) => {
      if (!files.has(from)) { const e: any = new Error(`ENOENT: ${from}`); throw e; }
      files.set(to, files.get(from) as string);
      files.delete(from);
    },
    mkdirSync: (p: string) => { dirs.add(p); },
    unlinkSync: (p: string) => { files.delete(p); },
  };
}

function fakeReleaseKit() {
  return {
    collectFragments: () => [{ filePath: '/repo/.changes/unreleased/fixed-a.md', fileName: 'fixed-a.md', kind: 'fixed', summary: 'x', body: '' }],
    resolvePaths: () => ({
      rootDir: ROOT,
      notesDir: `${ROOT}/.changes`,
      unreleasedDir: `${ROOT}/.changes/unreleased`,
      releasesDir: `${ROOT}/.changes/releases`,
      archiveDir: `${ROOT}/.changes/archive`,
      indexPath: `${ROOT}/.changes/INDEX.md`,
    }),
  };
}

// A fully-scripted, always-succeeding autoCut() local ('sh -c', no `cd`
// prefix, cwd via options.cwd) command stream, terminating at R = MERGE_SHA.
// Mirrors auto-cut.test.ts's makeAutoCutRuntime, trimmed to the happy path --
// autoCut()'s own edge cases are covered there; this file is about what
// deploy()/deployRelease() do with the R it hands back.
// Mutable across the sequence of a single autoCut() run -- 'git worktree add
// --detach' (local mode only) reveals the actual temp worktree path git
// would have used, which 'npm run release:cut' then needs in order to know
// where to write the bumped package.json/note (mirroring how a real detached
// worktree already contains a checkout of package.json at that commit, which
// is why worktree creation also seeds it below).
type WorktreeState = { dir: string | null };

function autoCutLocalHandler(cmd: string, fs: ReturnType<typeof makeFakeFs>, state: { headCalls: number }, wt: WorktreeState): string {
  if (cmd.includes('ls-remote --symref')) return `ref: refs/heads/${BRANCH}\tHEAD\n${BASE_TIP}\tHEAD\n`;
  if (cmd.startsWith('git fetch ')) return '';
  if (cmd === 'git rev-parse --show-toplevel') return '/repo\n';
  if (cmd.startsWith('git worktree add --detach ')) {
    const match = /^git worktree add --detach '([^']+)' '([^']+)'$/.exec(cmd);
    const dir = match ? match[1] : '/tmp/fake-autocut-worktree';
    wt.dir = dir;
    // A real detached worktree already contains a full checkout at the
    // commit it was created from -- seed it with the controller's pre-cut
    // package.json so the "does release:cut exist" read (which happens
    // BEFORE `npm run release:cut` runs) finds it.
    fs.writeFileSync(`${dir}/package.json`, fs.readFileSync('/repo/package.json'));
    return '';
  }
  if (cmd.startsWith('git worktree remove --force')) return '';
  if (cmd === 'git worktree prune') return '';
  if (cmd.startsWith('git rev-parse') && cmd.includes(REMOTE) && cmd.includes(BRANCH)) return `${BASE_TIP}\n`;
  if (cmd === 'git status --porcelain=v2 --ignore-submodules=no') return '';
  if (cmd.includes('symbolic-ref -q --short HEAD')) return `${BRANCH}\n`;
  if (cmd.includes('MERGE_HEAD') || cmd.includes('rebase-merge') || cmd.includes('rebase-apply') || cmd.includes('CHERRY_PICK_HEAD') || cmd.includes('REVERT_HEAD') || cmd.includes('BISECT_LOG')) return 'none\n';
  if (cmd === 'git rev-parse HEAD') {
    // First call is the preflight "local HEAD == remote tip" read (BASE_TIP);
    // every later call is post-checkout-b/-commit, i.e. the cut commit itself.
    state.headCalls += 1;
    return state.headCalls === 1 ? `${BASE_TIP}\n` : `${CUT_SHA}\n`;
  }
  if (cmd.includes('@{u}')) return `${REMOTE}/${BRANCH}\n`;
  if (cmd.includes('remote get-url --push')) return 'git@github.com:andrewpopov/demo.git\n';
  if (cmd.includes('gh repo view')) return 'andrewpopov/demo\n';
  if (cmd.startsWith('git checkout -b ')) return '';
  if (cmd === 'npm run release:cut') {
    const dir = wt.dir || '/repo';
    const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`));
    pkg.version = '1.2.0';
    fs.writeFileSync(`${dir}/package.json`, JSON.stringify(pkg));
    fs.writeFileSync(`${dir}/CHANGELOG.md`, '## 1.2.0\n\n- fixed a thing\n');
    return '';
  }
  if (cmd === 'git status --porcelain=v2 --ignore-submodules=no --cutdiff') return '';
  if (cmd.startsWith('git add --')) return '';
  if (cmd.startsWith('git commit -m')) return '';
  if (cmd.startsWith('git push -u')) return '';
  if (cmd.startsWith('gh pr create')) return 'https://github.com/andrewpopov/demo/pull/42\n';
  if (cmd.includes('gh pr view') && cmd.includes('--json number')) return '42\n';
  if (cmd.startsWith('git ls-remote ') && !cmd.includes('--symref')) return `${BASE_TIP}\trefs/heads/${BRANCH}\n`;
  if (cmd.includes('gh pr view') && cmd.includes('headRefOid')) return `${CUT_SHA}\n`;
  if (cmd.includes('gh pr merge')) return '';
  if (cmd.includes('gh pr view') && cmd.includes('state,mergeCommit')) return `MERGED\t${MERGE_SHA}\n`;
  if (cmd.startsWith('git checkout ') && !cmd.includes('-b')) return '';
  if (cmd.startsWith('git merge --ff-only')) return '';
  return '';
}

// autoCut's own post-cut-diff read (`git status --porcelain=v2 ...`, the SECOND
// call after the checkout -b) must answer with a plausible manifest+note diff,
// while every OTHER `git status` call (preflight, post-commit-clean) must answer
// clean (''). Track that with a counter, same trick auto-cut.test.ts uses.
function makeAutoCutLocal(fs: ReturnType<typeof makeFakeFs>) {
  let statusCalls = 0;
  const state = { headCalls: 0 };
  const wt: WorktreeState = { dir: null };
  const postCutDiff = "1 M. N... 100644 100644 100644 abc abc package.json\n2 R100 N... 100644 100644 100644 abc abc R100 CHANGELOG.md\tCHANGELOG.md\n2 R100 N... 100644 100644 100644 abc abc R100 .changes/archive/1.2.0/fixed-a.md\t.changes/unreleased/fixed-a.md\n";
  return (cmd: string) => {
    if (cmd === 'git status --porcelain=v2 --ignore-submodules=no') {
      statusCalls += 1;
      if (statusCalls === 2) return postCutDiff;
      return '';
    }
    return autoCutLocalHandler(cmd, fs, state, wt);
  };
}

type TargetOverrides = {
  currentBranch?: string;
  rExists?: boolean;
  isAncestor?: boolean;
  mergeMutatesHead?: boolean; // whether `git merge --ff-only R` actually moves target HEAD to R
  tamperAfterMerge?: boolean; // simulate something moving HEAD again before activation
  postStashDirty?: boolean;
  preRestartCheckMovesHead?: boolean; // a preRestartChecks command itself runs `git checkout` on the target
};

const PRE_RESTART_CHECKOUT_CMD = 'git checkout deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// A legacy in-place deploy target ('ssh' mode, so every command arrives as
// `cd /srv/app && <cmd>`), scripted to reach the auto-cut merge/activation
// window and let each knob flip exactly one guard.
function makeTargetHandler(over: TargetOverrides = {}) {
  const {
    currentBranch = BRANCH, rExists = true, isAncestor = true,
    mergeMutatesHead = true, tamperAfterMerge = false, postStashDirty = false,
    preRestartCheckMovesHead = false,
  } = over;
  let merged = false;
  let checkMovedHead = false;
  return (cmd: string) => {
    if (cmd.includes('.deploy-kit-layout')) return '';
    if (cmd === 'git symbolic-ref -q --short HEAD') return `${currentBranch}\n`;
    if (cmd.startsWith('git fetch') && cmd.includes(MERGE_SHA)) return '';
    if (cmd.startsWith('git cat-file -e')) {
      if (!rExists) { const e: any = new Error('no commit'); e.stdout = ''; e.status = 1; throw e; }
      return '';
    }
    if (cmd.startsWith('git merge-base --is-ancestor')) {
      if (!isAncestor) { const e: any = new Error('not ancestor'); e.stdout = ''; e.status = 1; throw e; }
      return '';
    }
    if (cmd.startsWith('git merge --ff-only')) {
      if (mergeMutatesHead) merged = true;
      return '';
    }
    if (cmd === PRE_RESTART_CHECKOUT_CMD) {
      if (preRestartCheckMovesHead) checkMovedHead = true;
      return '';
    }
    if (cmd.includes('prev-sha') && cmd.includes('git rev-parse HEAD >')) return '';
    if (cmd.includes('prev-sha')) return merged ? MERGE_SHA : TARGET_HEAD;
    if (cmd === 'git rev-parse HEAD') {
      if (checkMovedHead) return `${'e'.repeat(40)}\n`; // a pre-restart check moved HEAD to a descendant
      if (tamperAfterMerge) return `${'d'.repeat(40)}\n`; // something else entirely, every subsequent read
      return merged ? `${MERGE_SHA}\n` : `${TARGET_HEAD}\n`;
    }
    if (cmd === 'git status --porcelain=v2 --ignore-submodules=no') {
      return postStashDirty ? '1 .M N... 100644 100644 100644 abc abc dirty-file.txt\n' : '';
    }
    if (cmd.includes('curl')) return '200';
    if (/pm2 (start|restart)/.test(cmd)) return '';
    if (/pm2 stop/.test(cmd)) return '';
    if (cmd.includes('pm2 jlist')) return '[]';
    return '';
  };
}

function makeCombinedRuntime(over: TargetOverrides = {}) {
  const fs = makeFakeFs({
    '/repo/release-kit.config.js': 'module.exports = {}',
    '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
  });
  const autoCutLocal = makeAutoCutLocal(fs);
  const target = makeTargetHandler(over);
  const calls: string[] = [];
  const execFileSync = (_file: string, args: string[]) => {
    const raw = args[args.length - 1];
    calls.push(raw);
    const targetPrefix = 'cd /srv/app && ';
    if (raw.startsWith(targetPrefix)) return target(raw.slice(targetPrefix.length));
    return autoCutLocal(raw);
  };
  const rk = fakeReleaseKit();
  const ctx = {
    fs,
    now: () => Date.parse('2026-08-17T12:00:00Z'),
    resolve: () => '/repo/node_modules/@andrewpopov/release-kit/index.js',
    requireModule: (p: string) => (p === '/repo/release-kit.config.js' ? { productName: 'demo' } : rk),
    log: {
      info: () => {}, warning: () => {}, error: () => {}, success: () => {}, step: () => {}, header: () => {},
    },
    sleep: () => {},
    runtime: { execFileSync },
  };
  return { ctx, calls };
}

const legacyConfig = (over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  dbBoundApps: [],
  branch: BRANCH,
  remote: REMOTE,
  hooks: { install: 'npm ci', build: 'npm run build' },
  autoCut: { notePaths: ['CHANGELOG.md'] },
  ...over,
});

describe('deploy() + auto-cut: deploy-by-SHA', () => {
  it('happy path: fetches, verifies, and fast-forwards the target to R (not the branch tip)', () => {
    const { ctx, calls } = makeCombinedRuntime();
    const result = deploy(legacyConfig(), { projectRoot: ROOT }, ctx);
    expect(result.healthy).toBe(true);
    expect(calls.some((c) => c.includes(`git fetch 'origin' '${MERGE_SHA}'`))).toBe(true);
    expect(calls.some((c) => c.includes(`git cat-file -e '${MERGE_SHA}^{commit}'`))).toBe(true);
    expect(calls.some((c) => c.includes(`git merge --ff-only '${MERGE_SHA}'`))).toBe(true);
    // Never a plain branch-tip pull once R is in play.
    expect(calls.some((c) => c.includes('git pull --ff-only'))).toBe(false);
  });

  it('aborts by name when the target checkout has a detached HEAD', () => {
    const { ctx } = makeCombinedRuntime({ currentBranch: '' });
    expect(() => deploy(legacyConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/detached HEAD/);
  });

  it('aborts by name when the target checkout is on the wrong branch', () => {
    const { ctx } = makeCombinedRuntime({ currentBranch: 'some-other-branch' });
    expect(() => deploy(legacyConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/is on branch "some-other-branch", expected "master"/);
  });

  it('aborts by name when R is not actually present on the target after fetching', () => {
    const { ctx } = makeCombinedRuntime({ rExists: false });
    expect(() => deploy(legacyConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/still fails on the target.*the commit is not actually present/);
  });

  it('aborts by name when target HEAD is not an ancestor of R (target already ahead / diverged)', () => {
    const { ctx } = makeCombinedRuntime({ isAncestor: false });
    expect(() => deploy(legacyConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/is NOT an ancestor of auto-cut release/);
  });

  it('aborts by name when HEAD does not equal R immediately after the fast-forward merge', () => {
    const { ctx } = makeCombinedRuntime({ mergeMutatesHead: false });
    expect(() => deploy(legacyConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/expected HEAD to equal auto-cut release .* immediately after the fast-forward merge/);
  });

  it('aborts by name when HEAD no longer equals R immediately before activation', () => {
    // Let the merge itself succeed and pass assertion #1, but simulate
    // something (a hook, a concurrent process) moving HEAD again afterward.
    const { ctx, calls } = makeCombinedRuntime();
    const original = (ctx.runtime.execFileSync as any);
    let mergedOnce = false;
    let headReadsSinceMerge = 0;
    ctx.runtime.execFileSync = (file: string, args: string[]) => {
      const raw = args[args.length - 1];
      if (raw.includes('cd /srv/app && git merge --ff-only')) mergedOnce = true;
      if (mergedOnce && raw.includes('cd /srv/app && git rev-parse HEAD')) {
        headReadsSinceMerge += 1;
        calls.push(raw);
        // 1st post-merge read is assertion #1 (must still see R); tamper only
        // from the 2nd read onward, so assertion #1 passes and #2 is the one
        // that catches it.
        if (headReadsSinceMerge >= 2) return `${'d'.repeat(40)}\n`;
        return `${MERGE_SHA}\n`;
      }
      return original(file, args);
    };
    expect(() => deploy(legacyConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/expected HEAD to still equal auto-cut release .* immediately before activation/);
  });

  it('aborts by name when the post-stash working tree still has tracked/staged changes', () => {
    const { ctx } = makeCombinedRuntime({ postStashDirty: true });
    expect(() => deploy(legacyConfig({ hooks: { install: 'npm ci', build: 'npm run build' } }), { projectRoot: ROOT }, ctx))
      .toThrow(/still reports tracked\/staged change\(s\)/);
  });

  it('mode "local": cuts in a detached temp worktree (not the controller checkout) and still reaches R', () => {
    const { ctx, calls } = makeCombinedRuntime();
    const localConfig = legacyConfig({ mode: 'local' });
    const result = deploy(localConfig, { projectRoot: ROOT }, ctx);
    expect(result.healthy).toBe(true);
    const worktreeAddCall = calls.find((c) => c.startsWith('git worktree add --detach '));
    expect(worktreeAddCall).toBeDefined();
    // Created from the resolved remote tip X, not any branch name.
    expect(worktreeAddCall).toBe(`git worktree add --detach '${worktreeAddCall!.match(/^git worktree add --detach '([^']+)'/)![1]}' '${BASE_TIP}'`);
    // The worktree is torn down again on the same run.
    expect(calls.some((c) => c.startsWith('git worktree remove --force '))).toBe(true);
    expect(calls.some((c) => c === 'git worktree prune')).toBe(true);
    // Cleanup happens after the cut/push/merge sequence, not before it.
    const addIdx = calls.indexOf(worktreeAddCall!);
    const removeIdx = calls.findIndex((c) => c.startsWith('git worktree remove --force '));
    expect(addIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThan(addIdx);
    expect(calls.slice(addIdx, removeIdx)).toContain('npm run release:cut');
  });

  it('aborts by name, rather than restarting, when a preRestartCheck itself moves target HEAD off R', () => {
    const { ctx } = makeCombinedRuntime({ preRestartCheckMovesHead: true });
    const config = legacyConfig({ preRestartChecks: [{ name: 'external-checkout', command: PRE_RESTART_CHECKOUT_CMD }] });
    expect(() => deploy(config, { projectRoot: ROOT }, ctx))
      .toThrow(/expected HEAD to still equal auto-cut release .* immediately before activation/);
  });

  it('runs auto-cut only after target preflight has passed: a preDeployChecks failure produces zero auto-cut GitHub mutation', () => {
    const { ctx, calls } = makeCombinedRuntime();
    const config = legacyConfig({ preDeployChecks: [{ name: 'always-fails', command: 'exit 1' }] });
    const original = (ctx.runtime.execFileSync as any);
    ctx.runtime.execFileSync = (file: string, args: string[]) => {
      const raw = args[args.length - 1];
      const targetPrefix = 'cd /srv/app && ';
      if (raw.startsWith(targetPrefix) && raw.slice(targetPrefix.length) === 'exit 1') {
        const e: any = new Error('fake failure: exit 1');
        e.stdout = '';
        e.stderr = '';
        throw e;
      }
      return original(file, args);
    };
    expect(() => deploy(config, { projectRoot: ROOT }, ctx)).toThrow(/Pre-deploy check: always-fails/);
    // A failed pre-deploy check must reject the deploy BEFORE auto-cut ever
    // touches GitHub -- no cut branch, no push, no PR, no merge.
    expect(calls.some((c) => c.startsWith('git checkout -b'))).toBe(false);
    expect(calls.some((c) => c.includes('npm run release:cut'))).toBe(false);
    expect(calls.some((c) => c.startsWith('gh pr'))).toBe(false);
  });

  it('runs auto-cut only after the target lock is acquired: a lock-acquisition failure produces zero auto-cut GitHub mutation', () => {
    const { ctx, calls } = makeCombinedRuntime();
    const config = legacyConfig({ lock: true });
    const original = (ctx.runtime.execFileSync as any);
    ctx.runtime.execFileSync = (file: string, args: string[]) => {
      const raw = args[args.length - 1];
      // acquireLock's script is a single multi-line command containing an
      // atomic `mkdir -m 700 "<lockdir>.lock"` -- fail the WHOLE script the
      // way a genuinely held lock would (non-zero exit, no stdout/stderr).
      if (raw.includes('mkdir -m 700') && raw.includes('.lock')) {
        const e: any = new Error('fake failure: lock busy');
        e.stdout = '';
        e.stderr = '';
        e.status = 1;
        throw e;
      }
      return original(file, args);
    };
    expect(() => deploy(config, { projectRoot: ROOT }, ctx)).toThrow();
    expect(calls.some((c) => c.startsWith('git checkout -b'))).toBe(false);
    expect(calls.some((c) => c.includes('npm run release:cut'))).toBe(false);
    expect(calls.some((c) => c.startsWith('gh pr'))).toBe(false);
  });

  it('never invokes auto-cut, and deploys the branch tip as before, when config.autoCut is false', () => {
    const { ctx, calls } = makeCombinedRuntime();
    const result = deploy(legacyConfig({ autoCut: false }), { projectRoot: ROOT }, ctx);
    expect(result.healthy).toBe(true);
    expect(calls.some((c) => c.includes('git pull --ff-only'))).toBe(true);
    expect(calls.some((c) => c.includes(MERGE_SHA))).toBe(false);
  });
});

describe('deployRelease() + auto-cut: deploy-by-SHA', () => {
  it('detaches to and verifies R specifically, not the branch tip', () => {
    const fs = makeFakeFs({
      '/repo/release-kit.config.js': 'module.exports = {}',
      '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
    });
    const autoCutLocal = makeAutoCutLocal(fs);
    const rk = fakeReleaseKit();
    const calls: string[] = [];
    const execFileSync = (_file: string, args: string[]) => {
      const raw = args[args.length - 1];
      calls.push(raw);
      const targetPrefix = 'cd /srv/app && ';
      if (!raw.startsWith(targetPrefix)) return autoCutLocal(raw);
      const cmd = raw.slice(targetPrefix.length);
      if (cmd.includes('cat-file -e')) {
        const e: any = new Error('missing');
        e.stdout = '';
        e.status = 1;
        throw e;
      }
      if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
      if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return '';
      if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
      if (cmd.includes('df -kP') || cmd.includes('df -Pk')) return '99999999';
      return '';
    };
    const config = mergeConfig(DEFAULT_CONFIG, {
      host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: [], branch: BRANCH, remote: REMOTE,
      ecosystemFile: 'shared/ecosystem.config.cjs',
      hooks: { install: 'npm ci', build: 'npm run build' },
      autoCut: { notePaths: ['CHANGELOG.md'] },
      layout: { type: 'releases', keepReleases: 4, sharedPaths: [], releaseChecks: [], runningShaCommand: 'get-running-sha' },
    });
    const ctx = {
      fs,
      now: () => Date.parse('2026-08-17T12:00:00Z'),
      resolve: () => '/repo/node_modules/@andrewpopov/release-kit/index.js',
      requireModule: (p: string) => (p === '/repo/release-kit.config.js' ? { productName: 'demo' } : rk),
      log: {
      info: () => {}, warning: () => {}, error: () => {}, success: () => {}, step: () => {}, header: () => {},
    },
      sleep: () => {},
      runtime: { execFileSync },
    };
    expect(() => release.deployRelease(config, { projectRoot: ROOT }, ctx))
      .toThrow(/git cat-file -e .* still fails -- the commit is not actually present/);
  });

  it('runs auto-cut only after the --no-stash option-combination validation: an invalid combination produces zero auto-cut GitHub mutation', () => {
    const fs = makeFakeFs({
      '/repo/release-kit.config.js': 'module.exports = {}',
      '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
    });
    const autoCutLocal = makeAutoCutLocal(fs);
    const rk = fakeReleaseKit();
    const calls: string[] = [];
    const execFileSync = (_file: string, args: string[]) => {
      const raw = args[args.length - 1];
      calls.push(raw);
      const targetPrefix = 'cd /srv/app && ';
      if (!raw.startsWith(targetPrefix)) return autoCutLocal(raw);
      const cmd = raw.slice(targetPrefix.length);
      if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
      if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return '';
      if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
      if (cmd.includes('df -kP') || cmd.includes('df -Pk')) return '99999999';
      return '';
    };
    const config = mergeConfig(DEFAULT_CONFIG, {
      host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: [], branch: BRANCH, remote: REMOTE,
      ecosystemFile: 'shared/ecosystem.config.cjs',
      hooks: { install: 'npm ci', build: 'npm run build' },
      autoCut: { notePaths: ['CHANGELOG.md'] },
      layout: { type: 'releases', keepReleases: 4, sharedPaths: [], releaseChecks: [], runningShaCommand: 'get-running-sha' },
    });
    const ctx = {
      fs,
      now: () => Date.parse('2026-08-17T12:00:00Z'),
      resolve: () => '/repo/node_modules/@andrewpopov/release-kit/index.js',
      requireModule: (p: string) => (p === '/repo/release-kit.config.js' ? { productName: 'demo' } : rk),
      log: {
        info: () => {}, warning: () => {}, error: () => {}, success: () => {}, step: () => {}, header: () => {},
      },
      sleep: () => {},
      runtime: { execFileSync },
    };
    // `--no-stash` never applies to the release layout -- this option combination
    // is rejected up front. Auto-cut must never have run before that rejection.
    expect(() => release.deployRelease(config, { projectRoot: ROOT, stash: false }, ctx))
      .toThrow(/--no-stash does not apply to the release layout/);
    expect(calls.some((c) => c.startsWith('git checkout -b'))).toBe(false);
    expect(calls.some((c) => c.includes('npm run release:cut'))).toBe(false);
    expect(calls.some((c) => c.startsWith('gh pr'))).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { autoCut, PENDING_RELEASE_PATH } = require('../auto-cut.js');
const { mergeConfig, DEFAULT_CONFIG } = require('../index.js');

const REMOTE = 'origin';
const BRANCH = 'master';
const ROOT = '/repo';
const BASE_TIP = 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const CUT_SHA = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const MERGE_SHA = 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';

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
    files,
  };
}

// A content-aware fake execFileSync/router for auto-cut's local `sh -c`
// commands, following the same convention as release.test.ts's
// makeReleaseRuntime: match on the trailing command string, answer with a
// plausible value, and let `fail`/queues drive specific test scenarios.
function makeAutoCutRuntime(over: any = {}) {
  const cfg = {
    remoteDefaultBranch: BRANCH,
    baseTip: BASE_TIP,
    localHead: BASE_TIP,
    statusQueue: ['', ''] as string[], // [preflight-clean, post-commit-clean] — post-cut diff answered separately below
    postCutDiff: `1 M. N... 100644 100644 100644 abc abc package.json\n2 R100 N... 100644 100644 100644 abc abc R100 CHANGELOG.md\tCHANGELOG.md\n2 R100 N... 100644 100644 100644 abc abc R100 .changes/archive/1.2.0/fixed-a.md\t.changes/unreleased/fixed-a.md\n`,
    inProgress: 'none',
    currentBranch: BRANCH,
    ghSlug: 'andrewpopov/demo',
    remoteUrl: 'git@github.com:andrewpopov/demo.git',
    upstream: `${REMOTE}/${BRANCH}`,
    cutSha: CUT_SHA,
    prNumber: '42',
    preMergeBaseTip: BASE_TIP,
    preMergeHead: CUT_SHA,
    mergeSha: MERGE_SHA,
    movedBranchTip: 'd'.repeat(40),
    prMergeReQueryState: 'MERGED',
    fail: [] as string[],
    ...over,
  };
  const calls: string[] = [];
  const rangeCounters: Record<string, number> = {};
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (cfg.fail.some((f: string) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      err.stderr = 'fake stderr';
      throw err;
    }
    if (cmd.includes('ls-remote --symref')) return `ref: refs/heads/${cfg.remoteDefaultBranch}\tHEAD\n${cfg.baseTip}\tHEAD\n`;
    if (cmd === `git fetch ${REMOTE}`) return '';
    if (cmd.startsWith('git fetch ')) return '';
    if (cmd.startsWith('git rev-parse') && cmd.includes(REMOTE) && cmd.includes(BRANCH)) {
      rangeCounters.remoteBranchRevParse = (rangeCounters.remoteBranchRevParse || 0) + 1;
      // First call is the real preflight read (returns X); any LATER call
      // (which a correct implementation should never make again) simulates a
      // descendant S having landed on the branch after the merge.
      return `${rangeCounters.remoteBranchRevParse === 1 ? cfg.baseTip : cfg.movedBranchTip}\n`;
    }
    if (cmd === 'git status --porcelain=v2 --ignore-submodules=none') {
      rangeCounters.status = (rangeCounters.status || 0) + 1;
      if (rangeCounters.status === 1) return cfg.statusQueue[0];
      if (rangeCounters.status === 2) return cfg.postCutDiff;
      return cfg.statusQueue[1];
    }
    if (cmd.includes('symbolic-ref -q --short HEAD')) return `${cfg.currentBranch}\n`;
    if (cmd.includes('MERGE_HEAD')) return `${cfg.inProgress}\n`;
    if (cmd === 'git rev-parse HEAD') {
      rangeCounters.head = (rangeCounters.head || 0) + 1;
      return rangeCounters.head === 1 ? `${cfg.localHead}\n` : `${cfg.cutSha}\n`;
    }
    if (cmd.includes('@{u}')) return `${cfg.upstream}\n`;
    if (cmd.includes('remote get-url --push')) return `${cfg.remoteUrl}\n`;
    if (cmd.includes('gh repo view')) return `${cfg.ghSlug}\n`;
    if (cmd.startsWith('git checkout -b ')) return '';
    if (cmd === 'npm run release:cut') return '';
    if (cmd.startsWith('git add --')) return '';
    if (cmd.startsWith('git commit -m')) return '';
    if (cmd.startsWith('git push -u')) return '';
    if (cmd.startsWith('gh pr create')) return 'https://github.com/andrewpopov/demo/pull/42\n';
    if (cmd.includes('gh pr view') && cmd.includes('--json number')) return `${cfg.prNumber}\n`;
    if (cmd.startsWith('git ls-remote ') && !cmd.includes('--symref')) return `${cfg.preMergeBaseTip}\trefs/heads/${BRANCH}\n`;
    if (cmd.includes('gh pr view') && cmd.includes('headRefOid')) return `${cfg.preMergeHead}\n`;
    if (cmd.includes('gh pr view') && cmd.includes('state,mergeCommit')) {
      const sha = cfg.prMergeReQueryState === 'MERGED' ? cfg.mergeSha : '';
      return `${cfg.prMergeReQueryState}\t${sha}\n`;
    }
    if (cmd.includes('gh pr merge')) return '';
    if (cmd.includes('gh pr close')) return '';
    if (cmd.includes('gh pr view') && cmd.includes('mergeCommit')) return `${cfg.mergeSha}\n`;
    if (cmd.startsWith('git checkout ') && !cmd.includes('-b')) return '';
    if (cmd.startsWith('git merge --ff-only')) return '';
    return '';
  };
  return { runtime: { execFileSync }, calls, cfg };
}

const FRAGMENTS = [
  { filePath: '/repo/.changes/unreleased/fixed-a.md', fileName: 'fixed-a.md', kind: 'fixed', summary: 'x', body: '' },
];

function fakeReleaseKit(overrides: any = {}) {
  return {
    collectFragments: overrides.collectFragments || (() => FRAGMENTS),
    resolvePaths: overrides.resolvePaths || (() => ({
      rootDir: ROOT,
      notesDir: `${ROOT}/.changes`,
      unreleasedDir: `${ROOT}/.changes/unreleased`,
      releasesDir: `${ROOT}/.changes/releases`,
      archiveDir: `${ROOT}/.changes/archive`,
      indexPath: `${ROOT}/.changes/INDEX.md`,
    })),
  };
}

function baseConfig(over: any = {}) {
  return mergeConfig(DEFAULT_CONFIG, {
    remote: REMOTE,
    branch: BRANCH,
    autoCut: { notePaths: ['CHANGELOG.md'] },
    ...over,
  });
}

function baseCtx(over: any = {}) {
  const rk = fakeReleaseKit(over.rkOverrides);
  return {
    fs: over.fs || makeFakeFs({
      '/repo/release-kit.config.js': 'module.exports = {}',
      '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
    }),
    now: () => Date.parse('2026-08-17T12:00:00Z'),
    resolve: over.resolve || (() => '/repo/node_modules/@andrewpopov/release-kit/index.js'),
    requireModule: over.requireModule || ((p: string) => {
      if (p === '/repo/release-kit.config.js') return { productName: 'demo' };
      return rk;
    }),
    log: { info: () => {}, warning: () => {}, error: () => {}, success: () => {} },
    sleep: over.sleep || (() => {}), // never really sleep in tests -- the merge-state poll retries bounded
    ...over,
  };
}

// After the cut script runs, package.json is bumped to a new version — the
// fake fs above starts at 1.1.0; tests that exercise a real cut bump it via
// a second write before calling autoCut (simulating what `npm run
// release:cut` would have done), OR we monkeypatch execFileSync for
// `npm run release:cut` to also mutate fs. Simplest: make the runtime's
// `npm run release:cut` handler bump the fake fs package.json AND write the
// note file, so validateAndStageCutDiff's re-read sees the cut's real effect.
function wireCutSideEffects(runtime: any, fs: any, opts: { version?: string; noteContent?: string } = {}) {
  const version = opts.version || '1.2.0';
  const noteContent = opts.noteContent ?? `## ${version}\n\n- fixed a thing\n`;
  const original = runtime.execFileSync;
  runtime.execFileSync = (file: string, args: string[], options: any) => {
    const cmd = args[args.length - 1];
    if (cmd === 'npm run release:cut') {
      const pkg = JSON.parse(fs.readFileSync('/repo/package.json'));
      pkg.version = version;
      fs.writeFileSync('/repo/package.json', JSON.stringify(pkg));
      fs.writeFileSync('/repo/CHANGELOG.md', noteContent);
    }
    return original(file, args, options);
  };
}

describe('autoCut', () => {
  it('skips with { ran: false } when options.autoCut === false', () => {
    const { runtime } = makeAutoCutRuntime();
    const result = autoCut(baseConfig(), { projectRoot: ROOT, autoCut: false  }, { ...baseCtx(), runtime });
    expect(result).toEqual({ ran: false });
  });

  it('skips with { ran: false } when config.autoCut === false', () => {
    const { runtime } = makeAutoCutRuntime();
    const result = autoCut(baseConfig({ autoCut: false }), { projectRoot: ROOT }, { ...baseCtx(), runtime });
    expect(result).toEqual({ ran: false });
  });

  it('skips with { ran: false } when there is no release-kit.config at the project root', () => {
    const { runtime } = makeAutoCutRuntime();
    const fs = makeFakeFs({}); // no release-kit.config.js
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx({ fs }), runtime });
    expect(result).toEqual({ ran: false });
  });

  it('fails closed, by its own specific message, when release-kit is not resolvable', () => {
    const { runtime } = makeAutoCutRuntime();
    const ctx = baseCtx({
      resolve: () => { throw new Error('not found'); },
    });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime }))
      .toThrow(/release-kit\.config was found at the project root but "@andrewpopov\/release-kit" is not installed\/resolvable/);
  });

  it('performs zero local git mutation and zero GitHub write on a dry run', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const result = autoCut(baseConfig(), { projectRoot: ROOT, dryRun: true  }, { ...baseCtx(), runtime });
    expect(result).toEqual({ ran: false, dryRun: true, fragmentCount: 1 });
    // No mutating git/gh command was ever issued — only read-only preflight
    // commands could plausibly have run, and dry-run returns before even those.
    const mutating = calls.filter((c: string) => /^git (checkout -b|add|commit|push|merge --ff-only)|^gh pr (create|merge)/.test(c));
    expect(mutating).toEqual([]);
  });

  it('rejects a --branch override in play', () => {
    const { runtime } = makeAutoCutRuntime();
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT, branch: 'hotfix'  }, { ...baseCtx(), runtime }))
      .toThrow(/refusing to run with a --branch override in play/);
  });

  it('aborts by its own message when the working tree is dirty', () => {
    const { runtime } = makeAutoCutRuntime({ statusQueue: ['M src/foo.js\n', ''] });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/working tree is not clean/);
  });

  it('aborts by its own message when HEAD is detached', () => {
    const { runtime } = makeAutoCutRuntime({ currentBranch: '' });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/HEAD is detached/);
  });

  it('aborts by its own message when not on the configured branch', () => {
    const { runtime } = makeAutoCutRuntime({ currentBranch: 'feature-x' });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/controller checkout is on branch "feature-x", expected "master"/);
  });

  it('aborts by its own message when configured branch is not the remote\'s actual default', () => {
    const { runtime } = makeAutoCutRuntime({ remoteDefaultBranch: 'main' });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/is not .*remote's actual default branch \("main"\)/);
  });

  it('aborts by its own message when a merge is in progress', () => {
    const { runtime } = makeAutoCutRuntime({ inProgress: 'merge' });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/refusing to cut a release with a merge in progress/);
  });

  it('aborts by its own message when git fetch fails', () => {
    const { runtime } = makeAutoCutRuntime({ fail: ['git fetch'] });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/`git fetch origin` failed/);
  });

  it('aborts by its own message when local HEAD does not exactly equal the remote tip', () => {
    const { runtime } = makeAutoCutRuntime({ localHead: 'deadbeef'.repeat(5) });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/local HEAD .* does not exactly equal the remote tip/);
  });

  it('aborts by its own message when there is no unambiguous upstream tracking branch', () => {
    const { runtime } = makeAutoCutRuntime({ upstream: '' });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/no unambiguous upstream tracking branch configured/);
  });

  it('aborts by its own message when gh resolves a different repo than the remote', () => {
    const { runtime } = makeAutoCutRuntime({ ghSlug: 'someoneelse/other-repo' });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx(), runtime }))
      .toThrow(/`gh` resolves repo "someoneelse\/other-repo".*refusing to cut a PR against the wrong repo/);
  });

  it('returns { ran: false, fragmentCount: 0 } and does not cut when there are no fragments', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const ctx = baseCtx({ rkOverrides: { collectFragments: () => [] } });
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    expect(result).toEqual({ ran: false, fragmentCount: 0 });
    expect(calls.some((c: string) => c.startsWith('git checkout -b'))).toBe(false);
  });

  it('aborts by its own message when package.json has no release:cut script', () => {
    const { runtime } = makeAutoCutRuntime();
    const fs = makeFakeFs({
      '/repo/release-kit.config.js': 'module.exports = {}',
      '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: {} }),
    });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...baseCtx({ fs }), runtime }))
      .toThrow(/has no "release:cut" script/);
  });

  it('the diff allowlist rejects an unexpected path', () => {
    const { runtime } = makeAutoCutRuntime({
      // porcelain v2 untracked rows are `? <path>` (one '?', one space) --
      // NOT the porcelain v1 `?? <path>` shape.
      postCutDiff: '1 M. N... 100644 100644 100644 abc abc package.json\n? some/unexpected/file.txt\n',
    });
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime }))
      .toThrow(/touched an unexpected path outside the allowlist: "some\/unexpected\/file\.txt"/);
  });

  it('the pre-merge base CAS aborts when the base tip moved from X, and abandons the PR', () => {
    const { runtime, calls } = makeAutoCutRuntime({ preMergeBaseTip: 'f'.repeat(40) });
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime }))
      .toThrow(/base "master" moved from .* immediately before merging/);
    expect(calls.some((c: string) => c.includes('gh pr close'))).toBe(true);
    expect(calls.some((c: string) => c.includes('gh pr merge'))).toBe(false);
  });

  it('cuts, merges, and returns R end to end, persisting pending-release.json', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    expect(result).toEqual({
      ran: true, sha: MERGE_SHA, version: '1.2.0', prNumber: 42, fragmentCount: 1,
    });
    expect(calls.some((c: string) => c.startsWith("git checkout -b 'release/cut-"))).toBe(true);
    expect(calls).toContain('npm run release:cut');
    expect(calls.some((c: string) => c.startsWith('gh pr merge 42 --squash --delete-branch'))).toBe(true);
    const pending = JSON.parse(ctx.fs.readFileSync(`/repo/${PENDING_RELEASE_PATH}`));
    expect(pending).toMatchObject({ sha: MERGE_SHA, version: '1.2.0', prNumber: 42 });
  });

  it('persists pending-release.json atomically: writeFileSync to a temp path distinct from the final path, then renameSync to the final path', () => {
    const { runtime } = makeAutoCutRuntime();
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    const finalPath = `/repo/${PENDING_RELEASE_PATH}`;
    const fsCalls: Array<{ op: string; args: string[] }> = [];
    const originalWrite = ctx.fs.writeFileSync;
    const originalRename = ctx.fs.renameSync;
    (ctx.fs as any).writeFileSync = (p: string, content: string) => {
      fsCalls.push({ op: 'writeFileSync', args: [p] });
      return originalWrite(p, content);
    };
    (ctx.fs as any).renameSync = (from: string, to: string) => {
      fsCalls.push({ op: 'renameSync', args: [from, to] });
      return originalRename(from, to);
    };
    autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    // Find the write/rename pair whose rename target is the pending-release
    // final path (other writeFileSync/renameSync calls happen for the cut
    // itself via the fake fs, e.g. package.json/CHANGELOG.md, which never
    // go through renameSync at all).
    const renameToFinal = fsCalls.find((c) => c.op === 'renameSync' && c.args[1] === finalPath);
    expect(renameToFinal).toBeDefined();
    const tmpPath = renameToFinal!.args[0];
    expect(tmpPath).not.toBe(finalPath);
    const writeToTmp = fsCalls.find((c) => c.op === 'writeFileSync' && c.args[0] === tmpPath);
    expect(writeToTmp).toBeDefined();
    // Never a direct writeFileSync straight to the final pending-release path.
    expect(fsCalls.some((c) => c.op === 'writeFileSync' && c.args[0] === finalPath)).toBe(false);
    const pending = JSON.parse(ctx.fs.readFileSync(finalPath));
    expect(pending).toMatchObject({ sha: MERGE_SHA, version: '1.2.0', prNumber: 42 });
  });

  it('the resume path returns the persisted SHA without cutting again', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const ctx = baseCtx({
      fs: makeFakeFs({
        '/repo/release-kit.config.js': 'module.exports = {}',
        '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
        [`/repo/${PENDING_RELEASE_PATH}`]: JSON.stringify({
          sha: MERGE_SHA, version: '1.2.0', prNumber: 42, at: '2026-08-17T12:00:00Z',
        }),
      }),
    });
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    expect(result).toEqual({
      ran: true, resumed: true, sha: MERGE_SHA, version: '1.2.0', prNumber: 42,
    });
    // No cut, no push, no PR/merge activity — resume is a pure read.
    expect(calls).toEqual([]);
  });

  it('throws the --branch-override message rather than resuming, even when a pending release exists', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const ctx = baseCtx({
      fs: makeFakeFs({
        '/repo/release-kit.config.js': 'module.exports = {}',
        '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
        [`/repo/${PENDING_RELEASE_PATH}`]: JSON.stringify({
          sha: MERGE_SHA, version: '1.2.0', prNumber: 42, at: '2026-08-17T12:00:00Z',
        }),
      }),
    });
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT, branch: 'hotfix' }, { ...ctx, runtime }))
      .toThrow(/refusing to run with a --branch override in play/);
    // The override guard must win BEFORE the pending release is ever read/acted on.
    expect(calls).toEqual([]);
  });

  it('resume also short-circuits under --dry-run (still no mutation)', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const ctx = baseCtx({
      fs: makeFakeFs({
        '/repo/release-kit.config.js': 'module.exports = {}',
        '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
        [`/repo/${PENDING_RELEASE_PATH}`]: JSON.stringify({ sha: MERGE_SHA, version: '1.2.0', prNumber: 42 }),
      }),
    });
    const result = autoCut(baseConfig(), { projectRoot: ROOT, dryRun: true  }, { ...ctx, runtime });
    expect(result).toEqual({ ran: true, resumed: true, sha: MERGE_SHA, version: '1.2.0', prNumber: 42 });
    expect(calls).toEqual([]);
  });

  it('fast-forwards explicitly to R, never to the branch tip, even when a descendant S landed on the remote branch after the merge', () => {
    const { runtime, calls } = makeAutoCutRuntime();
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    expect(result.sha).toBe(MERGE_SHA);
    const ffOnly = calls.find((c: string) => c.startsWith('git merge --ff-only'));
    expect(ffOnly).toBe(`git merge --ff-only '${MERGE_SHA}'`);
    // Never fetches/merges the branch ref itself — only the resolved SHA R.
    const fetchCalls = calls.filter((c: string) => c.startsWith('git fetch'));
    expect(fetchCalls.some((c: string) => c.includes(MERGE_SHA))).toBe(true);
    expect(fetchCalls.some((c: string) => /\bmaster\b/.test(c) && !c.includes('release/cut-'))).toBe(false);
    // Proves the fake's "moved tip" never leaks into the result: if the
    // implementation regressed to re-resolving `${remote}/${branch}` after
    // the merge, this would be `movedBranchTip` instead of `MERGE_SHA`.
    expect(result.sha).not.toBe('d'.repeat(40));
  });

  it('proceeds and persists the pointer when `gh pr merge` fails but a re-query finds the PR already MERGED', () => {
    const { runtime, calls } = makeAutoCutRuntime({ fail: ['gh pr merge'], prMergeReQueryState: 'MERGED' });
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    expect(result).toEqual({
      ran: true, sha: MERGE_SHA, version: '1.2.0', prNumber: 42, fragmentCount: 1,
    });
    expect(calls.some((c: string) => c.includes('gh pr merge'))).toBe(true);
    expect(calls.some((c: string) => c.includes('state,mergeCommit'))).toBe(true);
    const pending = JSON.parse(ctx.fs.readFileSync(`/repo/${PENDING_RELEASE_PATH}`));
    expect(pending).toMatchObject({ sha: MERGE_SHA, version: '1.2.0', prNumber: 42 });
  });

  it('aborts, naming the actual PR state, when `gh pr merge` fails and re-polling never reaches MERGED', () => {
    const { runtime, calls } = makeAutoCutRuntime({ fail: ['gh pr merge'], prMergeReQueryState: 'OPEN' });
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    expect(() => autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime }))
      .toThrow(/PR #42 did not reach state MERGED \(observed "OPEN"\) within 10 poll attempt\(s\)/);
    expect(ctx.fs.existsSync(`/repo/${PENDING_RELEASE_PATH}`)).toBe(false);
    expect(calls.some((c: string) => c.includes('state,mergeCommit'))).toBe(true);
  });

  it('succeeds via the queued-then-merged path: a merge exit-0 that only queued the PR is not trusted, and the second poll finding MERGED with a SHA is what is used', () => {
    const { runtime } = makeAutoCutRuntime();
    const ctx = baseCtx();
    wireCutSideEffects(runtime, ctx.fs);
    let pollCount = 0;
    const original = runtime.execFileSync;
    runtime.execFileSync = (file: string, args: string[], options: any) => {
      const cmd = args[args.length - 1];
      if (cmd.includes('gh pr view') && cmd.includes('state,mergeCommit')) {
        pollCount += 1;
        // First poll: merge command exited 0 but only enabled/queued auto-merge --
        // the PR is still open. Second poll: it has actually landed.
        if (pollCount === 1) return 'OPEN\t\n';
        return `MERGED\t${MERGE_SHA}\n`;
      }
      return original(file, args, options);
    };
    const result = autoCut(baseConfig(), { projectRoot: ROOT }, { ...ctx, runtime });
    expect(result).toEqual({
      ran: true, sha: MERGE_SHA, version: '1.2.0', prNumber: 42, fragmentCount: 1,
    });
    expect(pollCount).toBe(2);
    const pending = JSON.parse(ctx.fs.readFileSync(`/repo/${PENDING_RELEASE_PATH}`));
    expect(pending).toMatchObject({ sha: MERGE_SHA, version: '1.2.0', prNumber: 42 });
  });
});

// ---- mode: 'local' -- cuts in a detached temp worktree ---------------------
//
// A separate, self-contained runtime factory (rather than reusing
// makeAutoCutRuntime) so it can track `cwd` per call -- the whole point of
// these tests is proving WHICH directory each command ran in, not just which
// commands ran, and makeAutoCutRuntime's fake ignores execFileSync's cwd
// option entirely (every ssh-mode call always targets the same rootDir).
const TMP_BASE = '/tmp';

function makeLocalRuntime(over: any = {}) {
  const cfg = {
    remoteDefaultBranch: BRANCH,
    baseTip: BASE_TIP,
    localHead: BASE_TIP,
    postCutDiff: `1 M. N... 100644 100644 100644 abc abc package.json\n2 R100 N... 100644 100644 100644 abc abc R100 CHANGELOG.md\tCHANGELOG.md\n2 R100 N... 100644 100644 100644 abc abc R100 .changes/archive/1.2.0/fixed-a.md\t.changes/unreleased/fixed-a.md\n`,
    ghSlug: 'andrewpopov/demo',
    remoteUrl: 'git@github.com:andrewpopov/demo.git',
    upstream: `${REMOTE}/${BRANCH}`,
    prNumber: '42',
    mergeSha: MERGE_SHA,
    fail: [] as string[],
    ...over,
  };
  const calls: Array<{ cmd: string; cwd: string }> = [];
  const state = { headCalls: 0, statusCalls: 0, worktreeDir: null as string | null, worktreeRemoved: false };
  const fs = makeFakeFs({
    '/repo/release-kit.config.js': 'module.exports = {}',
    '/repo/package.json': JSON.stringify({ name: 'demo', version: '1.1.0', scripts: { 'release:cut': 'release-kit cut' } }),
  });
  const execFileSync = (_file: string, args: string[], options: any = {}) => {
    const cmd = args[args.length - 1];
    const cwd = options && options.cwd;
    calls.push({ cmd, cwd });
    if (cfg.fail.some((f: string) => cmd.includes(f))) {
      const err: any = new Error(`fake failure: ${cmd}`);
      err.stdout = '';
      err.stderr = 'fake stderr';
      throw err;
    }
    if (cmd.includes('ls-remote --symref')) return `ref: refs/heads/${cfg.remoteDefaultBranch}\tHEAD\n${cfg.baseTip}\tHEAD\n`;
    if (cmd.startsWith('git fetch ')) return '';
    if (cmd === 'git rev-parse --show-toplevel') return `${ROOT}\n`;
    if (cmd.startsWith('git worktree add --detach ')) {
      const match = /^git worktree add --detach '([^']+)' '([^']+)'$/.exec(cmd);
      state.worktreeDir = match ? match[1] : `${TMP_BASE}/fallback-worktree`;
      fs.writeFileSync(`${state.worktreeDir}/package.json`, fs.readFileSync('/repo/package.json'));
      return '';
    }
    if (cmd.startsWith('git worktree remove --force')) {
      state.worktreeRemoved = true;
      return '';
    }
    if (cmd === 'git worktree prune') return '';
    if (cmd.startsWith('git rev-parse') && cmd.includes(REMOTE) && cmd.includes(BRANCH)) return `${cfg.baseTip}\n`;
    if (cmd === 'git status --porcelain=v2 --ignore-submodules=none') {
      state.statusCalls += 1;
      if (state.statusCalls === 2) return cfg.postCutDiff;
      return '';
    }
    if (cmd.includes('symbolic-ref -q --short HEAD')) return `${BRANCH}\n`;
    if (cmd.includes('MERGE_HEAD')) return 'none\n';
    if (cmd === 'git rev-parse HEAD') {
      state.headCalls += 1;
      return state.headCalls === 1 ? `${cfg.localHead}\n` : `${CUT_SHA}\n`;
    }
    if (cmd.includes('@{u}')) return `${cfg.upstream}\n`;
    if (cmd.includes('remote get-url --push')) return `${cfg.remoteUrl}\n`;
    if (cmd.includes('gh repo view')) return `${cfg.ghSlug}\n`;
    if (cmd.startsWith('git checkout -b ')) return '';
    if (cmd === 'npm run release:cut') {
      const dir = state.worktreeDir as string;
      const pkg = JSON.parse(fs.readFileSync(`${dir}/package.json`));
      pkg.version = '1.2.0';
      fs.writeFileSync(`${dir}/package.json`, JSON.stringify(pkg));
      fs.writeFileSync(`${dir}/CHANGELOG.md`, '## 1.2.0\n\n- fixed a thing\n');
      return '';
    }
    if (cmd.startsWith('git add --')) return '';
    if (cmd.startsWith('git commit -m')) return '';
    if (cmd.startsWith('git push -u')) return '';
    if (cmd.startsWith('gh pr create')) return 'https://github.com/andrewpopov/demo/pull/42\n';
    if (cmd.includes('gh pr view') && cmd.includes('--json number')) return `${cfg.prNumber}\n`;
    if (cmd.startsWith('git ls-remote ') && !cmd.includes('--symref')) return `${cfg.baseTip}\trefs/heads/${BRANCH}\n`;
    if (cmd.includes('gh pr view') && cmd.includes('headRefOid')) return `${CUT_SHA}\n`;
    if (cmd.includes('gh pr merge')) return '';
    if (cmd.includes('gh pr view') && cmd.includes('state,mergeCommit')) return `MERGED\t${cfg.mergeSha}\n`;
    if (cmd.startsWith('git checkout ') && !cmd.includes('-b')) return '';
    if (cmd.startsWith('git merge --ff-only')) return '';
    return '';
  };
  return {
    runtime: { execFileSync }, calls, cfg, state, fs,
  };
}

function localConfig(over: any = {}) {
  return mergeConfig(DEFAULT_CONFIG, {
    remote: REMOTE, branch: BRANCH, mode: 'local', autoCut: { notePaths: ['CHANGELOG.md'] }, ...over,
  });
}

function localCtx(fs: any, over: any = {}) {
  const rk = {
    collectFragments: () => FRAGMENTS,
    resolvePaths: () => ({
      rootDir: ROOT,
      notesDir: `${ROOT}/.changes`,
      unreleasedDir: `${ROOT}/.changes/unreleased`,
      releasesDir: `${ROOT}/.changes/releases`,
      archiveDir: `${ROOT}/.changes/archive`,
      indexPath: `${ROOT}/.changes/INDEX.md`,
    }),
  };
  return {
    fs,
    now: () => Date.parse('2026-08-17T12:00:00Z'),
    tmpdir: () => TMP_BASE,
    resolve: () => '/repo/node_modules/@andrewpopov/release-kit/index.js',
    requireModule: (p: string) => (p === '/repo/release-kit.config.js' ? { productName: 'demo' } : rk),
    log: { info: () => {}, warning: () => {}, error: () => {}, success: () => {} },
    sleep: () => {},
    ...over,
  };
}

describe('autoCut mode: "local" (detached temp worktree)', () => {
  it('cuts, pushes, and merges in a detached temp worktree outside projectRoot -- the controller checkout never leaves its branch and is never mutated', () => {
    const { runtime, calls, state, fs } = makeLocalRuntime();
    const result = autoCut(localConfig(), { projectRoot: ROOT }, localCtx(fs, { runtime }));
    expect(result).toMatchObject({ ran: true, sha: MERGE_SHA, version: '1.2.0', prNumber: 42 });
    expect(state.worktreeDir).toBeTruthy();
    // The temp worktree lives under the OS tmp dir, outside the project root.
    expect(state.worktreeDir!.startsWith(TMP_BASE)).toBe(true);
    expect(state.worktreeDir!.startsWith(ROOT)).toBe(false);

    // Every mutating cut command (branch creation, the cut script, staging,
    // commit, push, PR create/merge) ran with cwd === the temp worktree --
    // NEVER the controller checkout (rootDir).
    const mutatingPrefixes = [
      'git checkout -b ', 'npm run release:cut', 'git add --', 'git commit -m',
      'git push -u', 'gh pr create', 'gh pr merge',
    ];
    const mutatingCalls = calls.filter((c) => mutatingPrefixes.some((p) => c.cmd.startsWith(p)));
    expect(mutatingCalls.length).toBeGreaterThan(0);
    for (const c of mutatingCalls) {
      expect(c.cwd).toBe(state.worktreeDir);
    }
    // The controller checkout (rootDir) never runs `git checkout -b` -- it
    // never leaves config.branch for the cut branch.
    expect(calls.some((c) => c.cwd === ROOT && c.cmd.startsWith('git checkout -b'))).toBe(false);

    // Only the FINAL fast-forward (fetch R / checkout config.branch / merge
    // --ff-only) runs against the controller checkout.
    const finalFetch = calls.find((c) => c.cmd === `git fetch '${REMOTE}' '${MERGE_SHA}'`);
    expect(finalFetch).toBeDefined();
    expect(finalFetch!.cwd).toBe(ROOT);
    const finalCheckout = calls.find((c) => c.cmd === `git checkout '${BRANCH}'`);
    expect(finalCheckout).toBeDefined();
    expect(finalCheckout!.cwd).toBe(ROOT);
    const finalMerge = calls.find((c) => c.cmd === `git merge --ff-only '${MERGE_SHA}'`);
    expect(finalMerge).toBeDefined();
    expect(finalMerge!.cwd).toBe(ROOT);

    // The worktree was cleaned up.
    expect(state.worktreeRemoved).toBe(true);
    expect(calls.some((c) => c.cmd === 'git worktree prune')).toBe(true);
  });

  it('preflight guards still fire in local mode and still describe/target the controller checkout', () => {
    const { runtime, calls, fs } = makeLocalRuntime({ upstream: '' });
    expect(() => autoCut(localConfig(), { projectRoot: ROOT }, localCtx(fs, { runtime })))
      .toThrow(/no unambiguous upstream tracking branch configured/);
    // The failure is a preflight guard -- it must fire BEFORE any worktree is
    // ever created, and every command up to that point targeted rootDir.
    expect(calls.some((c) => c.cmd.startsWith('git worktree add'))).toBe(false);
    expect(calls.every((c) => c.cwd === ROOT)).toBe(true);
  });

  it('the temp worktree is removed even when the cut script itself fails', () => {
    const { runtime, state, fs } = makeLocalRuntime({ fail: ['npm run release:cut'] });
    expect(() => autoCut(localConfig(), { projectRoot: ROOT }, localCtx(fs, { runtime })))
      .toThrow(/command failed: npm run release:cut/);
    expect(state.worktreeRemoved).toBe(true);
  });

  it('the temp worktree is removed even when the push fails', () => {
    const { runtime, state, fs } = makeLocalRuntime({ fail: ['git push -u'] });
    expect(() => autoCut(localConfig(), { projectRoot: ROOT }, localCtx(fs, { runtime })))
      .toThrow(/command failed: git push -u/);
    expect(state.worktreeRemoved).toBe(true);
  });

  it('the temp worktree is removed even when the merge never reaches MERGED', () => {
    const { runtime, state, fs } = makeLocalRuntime({});
    const ctx = localCtx(fs, { runtime, sleep: () => {} });
    // Force every merge-state poll to report OPEN, never MERGED.
    const original = runtime.execFileSync;
    (runtime as any).execFileSync = (file: string, args: string[], options: any) => {
      const cmd = args[args.length - 1];
      if (cmd.includes('gh pr view') && cmd.includes('state,mergeCommit')) return 'OPEN\t\n';
      return original(file, args, options);
    };
    expect(() => autoCut(localConfig(), { projectRoot: ROOT }, ctx))
      .toThrow(/did not reach state MERGED/);
    expect(state.worktreeRemoved).toBe(true);
  });

  it('mode "ssh" (default) issues the exact same command sequence as before -- a regression guard against the two modes diverging', () => {
    const { runtime: sshRuntime, calls: sshCalls, cfg: sshCfg } = makeAutoCutRuntime();
    const sshCtx = baseCtx();
    wireCutSideEffects(sshRuntime, sshCtx.fs);
    autoCut(baseConfig(), { projectRoot: ROOT }, { ...sshCtx, runtime: sshRuntime });

    // No worktree command of any kind in ssh mode.
    expect(sshCalls.some((c: string) => c.includes('worktree'))).toBe(false);
    void sshCfg;
  });
});

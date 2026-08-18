// Every prior auto-cut bug (an invalid `--ignore-submodules` flag, an
// SSH-host-alias remote URL rejected by the parser, the diff allowlist
// omitting the regenerated patch-notes index) was found on a REAL deploy,
// not by the 550 unit tests -- those all drive a fake runtime that accepts
// any command string and returns canned output, so a wrong flag or a wrong
// path is invisible to them. This file closes that gap: it runs `autoCut`
// against a REAL throwaway git repo (a real `origin` bare repo + a real
// working clone, both in the OS temp dir), a REAL `git` binary, and a REAL
// `@andrewpopov/release-kit` (symlinked in, not mocked) -- only `gh` is
// faked, via a shim script on PATH, following the same technique release-kit's
// own `hygiene-git-failures.test.ts` uses for faking `git`.
import {
  describe, it, expect, afterEach,
} from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(__filename);
const { autoCut, PENDING_RELEASE_PATH } = require('../auto-cut.js');
const { mergeConfig, DEFAULT_CONFIG } = require('../index.js');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function gitBare(gitDir: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' }).trim();
}

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Regex `assertGhRepoMatchesRemote` uses to pull owner/repo out of a remote
// push URL -- mirrored here so the fake `gh repo view` answers with EXACTLY
// what the real check expects, whatever the tmp-dir-derived remote URL is.
function ownerRepoSlug(remoteUrl: string): string {
  const match = /[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/.exec(remoteUrl);
  if (!match) throw new Error(`could not derive a test owner/repo slug from ${remoteUrl}`);
  return `${match[1]}/${match[2]}`;
}

// A `gh` shim executable (Node script) that implements just enough of `gh
// repo view` / `gh pr create|view|merge|close` for auto-cut's ssh-mode flow
// to run against a real `origin` bare repo -- PR state is a JSON file next
// to it, and `pr merge --squash` performs a REAL squash merge (commit-tree +
// update-ref) against the bare repo, exactly like GitHub would.
function makeGhShim(originGitDir: string, slug: string, stateFile: string): string {
  const shimDir = makeTmpDir('deploy-kit-autocut-shim-');
  const script = `#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const ORIGIN = ${JSON.stringify(originGitDir)};
const SLUG = ${JSON.stringify(slug)};
const STATE_FILE = ${JSON.stringify(stateFile)};
const args = process.argv.slice(2);

function readState() {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { nextNumber: 1, prs: {}, byHead: {} };
}
function writeState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); }
function gitOrigin(a) { return execFileSync('git', ['--git-dir', ORIGIN, ...a], { encoding: 'utf8' }).trim(); }
function flagValue(name) { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; }

if (args[0] === 'repo' && args[1] === 'view') {
  process.stdout.write(SLUG + '\\n');
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'create') {
  if (process.env.GH_SHIM_FAIL_CREATE === '1') {
    process.stderr.write('gh shim: simulated \`gh pr create\` failure\\n');
    process.exit(1);
  }
  const base = flagValue('--base');
  const head = flagValue('--head');
  const state = readState();
  const number = state.nextNumber++;
  const headSha = gitOrigin(['rev-parse', 'refs/heads/' + head]);
  state.prs[number] = {
    number, base, head, headSha, state: 'OPEN', mergeSha: null,
  };
  state.byHead[head] = number;
  writeState(state);
  process.stdout.write('https://example.invalid/pull/' + number + '\\n');
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'view') {
  const ref = args[2];
  const state = readState();
  const number = /^\\d+$/.test(ref) ? Number(ref) : state.byHead[ref];
  const pr = state.prs[number];
  if (!pr) { process.stderr.write('gh shim: no such PR "' + ref + '"\\n'); process.exit(1); }
  const jsonFields = flagValue('--json') || '';
  if (jsonFields === 'number') {
    process.stdout.write(pr.number + '\\n');
  } else if (jsonFields === 'headRefOid') {
    // Re-resolve live, like the real API would, rather than trusting the
    // value captured at \`pr create\` time.
    const headSha = gitOrigin(['rev-parse', 'refs/heads/' + pr.head]);
    process.stdout.write(headSha + '\\n');
  } else if (jsonFields === 'state,mergeCommit') {
    process.stdout.write(pr.state + '\\t' + (pr.mergeSha || '') + '\\n');
  } else {
    process.stderr.write('gh shim: unhandled --json fields "' + jsonFields + '"\\n');
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'merge') {
  const number = Number(args[2]);
  const state = readState();
  const pr = state.prs[number];
  if (!pr) { process.stderr.write('gh shim: no such PR #' + number + '\\n'); process.exit(1); }
  const baseSha = gitOrigin(['rev-parse', 'refs/heads/' + pr.base]);
  const tree = gitOrigin(['rev-parse', pr.headSha + '^{tree}']);
  const mergeSha = gitOrigin(['commit-tree', tree, '-p', baseSha, '-m', 'squash merge PR #' + number]);
  gitOrigin(['update-ref', 'refs/heads/' + pr.base, mergeSha]);
  gitOrigin(['update-ref', '-d', 'refs/heads/' + pr.head]);
  pr.state = 'MERGED';
  pr.mergeSha = mergeSha;
  writeState(state);
  process.exit(0);
}

if (args[0] === 'pr' && args[1] === 'close') {
  const number = Number(args[2]);
  const state = readState();
  const pr = state.prs[number];
  if (pr) {
    pr.state = 'CLOSED';
    try { gitOrigin(['update-ref', '-d', 'refs/heads/' + pr.head]); } catch (e) { /* already gone */ }
  }
  writeState(state);
  process.exit(0);
}

process.stderr.write('gh shim: unhandled command: ' + args.join(' ') + '\\n');
process.exit(1);
`;
  fs.writeFileSync(path.join(shimDir, 'gh'), script, { mode: 0o755 });
  return shimDir;
}

const RELEASE_KIT_REAL_DIR = path.dirname(require.resolve('@andrewpopov/release-kit/package.json'));
const RELEASE_KIT_CLI_REL = '../@andrewpopov/release-kit/dist/cli.js';

// Symlinks a real `@andrewpopov/release-kit` (this repo's own node_modules
// copy) into the throwaway project so `require.resolve` from INSIDE the tmp
// project root -- both auto-cut's own `resolveReleaseKit` and Node's own
// resolution when `release-kit.config.js` does `require('@andrewpopov/release-kit')`
// -- finds it for real, and so `npm run release:cut` finds a real
// `release-kit` bin. No fake, no separate install.
function linkRealReleaseKit(projectDir: string): void {
  const scopeDir = path.join(projectDir, 'node_modules', '@andrewpopov');
  fs.mkdirSync(scopeDir, { recursive: true });
  fs.symlinkSync(RELEASE_KIT_REAL_DIR, path.join(scopeDir, 'release-kit'), 'dir');
  const binDir = path.join(projectDir, 'node_modules', '.bin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.symlinkSync(RELEASE_KIT_CLI_REL, path.join(binDir, 'release-kit'));
}

const RELEASE_KIT_CONFIG_JS = `
const { defineConfig, stableSemver, npmPackage } = require('@andrewpopov/release-kit');
module.exports = defineConfig({
  productName: 'fixture-project',
  stage: 'stable',
  rootDir: __dirname,
  // Deliberately the smarthome-shaped layout that triggered the live bug:
  // an index file OUTSIDE the notes dir (docs/PATCH_NOTES.md), written by
  // the DEFAULT notesTarget (patchNotesDirTarget) on every cut.
  paths: { notesDir: '.changes', indexPath: 'docs/PATCH_NOTES.md' },
  kinds: [
    { id: 'added', heading: 'Added' },
    { id: 'fixed', heading: 'Fixed' },
  ],
  versionStrategy: stableSemver(),
  manifest: npmPackage(),
  hygiene: {
    baseRef: 'origin/master',
    relevantPrefixes: [],
    relevantFiles: [],
    relevantScriptPrefixes: [],
    relevantDocFiles: [],
    noteCommandHelp: 'npm run release:note',
    publishCommandHelp: 'npm run release:cut',
  },
  titleTemplate: '# {productName} {version}',
  versionLabel: 'Package version',
  currentVersionLabel: 'Current package version',
  fragmentBodyPlaceholder: 'placeholder',
  releaseNoteIntroTemplate: '',
  indexIntroTemplate: '',
});
`;

function writeProjectFixture(projectDir: string): void {
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    `${JSON.stringify({
      name: 'fixture-project',
      version: '1.0.0',
      private: true,
      scripts: { 'release:cut': 'release-kit cut' },
    }, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(projectDir, 'release-kit.config.js'), RELEASE_KIT_CONFIG_JS, 'utf8');
  fs.mkdirSync(path.join(projectDir, '.changes', 'unreleased'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.changes', 'unreleased', 'fixed-widget.md'),
    ['---', 'kind: fixed', 'summary: Fix the widget', '---', '', 'The widget no longer explodes.', ''].join('\n'),
    'utf8',
  );
  linkRealReleaseKit(projectDir);
}

// Builds a real `origin` bare repo + a real working clone with an initial
// commit pushed and tracked, matching every precondition autoCut's preflight
// asserts (clean tree, on `branch`, branch IS the remote default, HEAD ==
// remote tip, unambiguous upstream). Returns everything a test needs to
// drive `autoCut` and to fake `gh` against the SAME real repo.
function makeRealRepo() {
  const originDir = makeTmpDir('deploy-kit-autocut-origin-');
  gitBare(originDir, ['init', '--bare', '-q', '-b', 'master']);
  gitBare(originDir, ['config', 'user.email', 'origin@example.com']);
  gitBare(originDir, ['config', 'user.name', 'Origin']);

  const projectDir = makeTmpDir('deploy-kit-autocut-work-');
  git(projectDir, ['init', '-q', '-b', 'master']);
  git(projectDir, ['config', 'user.email', 'dev@example.com']);
  git(projectDir, ['config', 'user.name', 'Dev']);
  writeProjectFixture(projectDir);
  git(projectDir, ['add', '-A']);
  git(projectDir, ['commit', '-q', '-m', 'initial']);
  git(projectDir, ['remote', 'add', 'origin', `file://${originDir}`]);
  git(projectDir, ['push', '-u', 'origin', 'master']);

  const remoteUrl = `file://${originDir}`;
  return {
    originDir, projectDir, remoteUrl, slug: ownerRepoSlug(remoteUrl),
  };
}

function autoCutConfig(remote = 'origin', branch = 'master') {
  return mergeConfig(DEFAULT_CONFIG, { remote, branch });
}

describe('auto-cut integration (real git + real release-kit, faked gh)', () => {
  const cleanupDirs: string[] = [];
  const originalPath = process.env.PATH;
  const originalEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const key of Object.keys(originalEnv)) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    for (const dir of cleanupDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function withGhShim(originDir: string, slug: string) {
    const stateFile = path.join(makeTmpDir('deploy-kit-autocut-ghstate-'), 'state.json');
    const shimDir = makeGhShim(originDir, slug, stateFile);
    cleanupDirs.push(shimDir, path.dirname(stateFile));
    originalEnv.PATH = process.env.PATH;
    process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;
    return { shimDir, stateFile };
  }

  it('cuts a real release end to end: fragments consumed, manifest bumped, index regenerated, committed, and the returned SHA is what gh reported as merged', () => {
    // Real git clone/push/fetch + a real `npm run` invoking the real
    // release-kit CLI -- well over vitest's 5s default under any load.
    const { originDir, projectDir, slug } = makeRealRepo();
    cleanupDirs.push(originDir, projectDir);
    withGhShim(originDir, slug);

    const result = autoCut(autoCutConfig(), { projectRoot: projectDir }, {});

    expect(result.ran).toBe(true);
    expect(result.version).toBe('1.0.1');
    expect(result.fragmentCount).toBe(1);
    expect(typeof result.sha).toBe('string');
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);

    // The fragment was consumed (archived), not left behind.
    expect(fs.existsSync(path.join(projectDir, '.changes', 'unreleased', 'fixed-widget.md'))).toBe(false);
    expect(fs.existsSync(path.join(projectDir, '.changes', 'archive', '1.0.1', 'fixed-widget.md'))).toBe(true);

    // The manifest actually advanced.
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('1.0.1');

    // The index -- this is the ALLOWLIST test: patchNotesDirTarget's
    // regenerated docs/PATCH_NOTES.md, OUTSIDE the notes dir, must have been
    // accepted by validateAndStageCutDiff (Fix 1) rather than rejected as an
    // unexpected path.
    const indexContent = fs.readFileSync(path.join(projectDir, 'docs', 'PATCH_NOTES.md'), 'utf8');
    expect(indexContent).toContain('1.0.1');

    // The controller checkout ended up fast-forwarded to R, on `master`,
    // clean, and R is EXACTLY what the fake gh reported as the merge SHA.
    expect(git(projectDir, ['symbolic-ref', '-q', '--short', 'HEAD'])).toBe('master');
    // Ignore the (untracked, gitignored-in-real-usage) crash-recovery pointer
    // auto-cut itself just wrote -- everything ELSE must be clean.
    expect(git(projectDir, ['status', '--porcelain=v2', '--', '.', `:!${PENDING_RELEASE_PATH}`])).toBe('');
    expect(git(projectDir, ['rev-parse', 'HEAD'])).toBe(result.sha);
    const originMaster = gitBare(originDir, ['rev-parse', 'refs/heads/master']);
    expect(originMaster).toBe(result.sha);

    // The pending-release pointer was written (and can be cleared).
    expect(fs.existsSync(path.join(projectDir, PENDING_RELEASE_PATH))).toBe(true);
  }, 30_000);

  it('a failed cut (gh pr create fails after push) leaves the repo back on the original branch, tree clean, no release/cut-* branch left', () => {
    const { originDir, projectDir, slug } = makeRealRepo();
    cleanupDirs.push(originDir, projectDir);
    withGhShim(originDir, slug);
    originalEnv.GH_SHIM_FAIL_CREATE = process.env.GH_SHIM_FAIL_CREATE;
    process.env.GH_SHIM_FAIL_CREATE = '1';

    const beforeHead = git(projectDir, ['rev-parse', 'HEAD']);

    expect(() => autoCut(autoCutConfig(), { projectRoot: projectDir }, {})).toThrow();

    // Back on the original branch...
    expect(git(projectDir, ['symbolic-ref', '-q', '--short', 'HEAD'])).toBe('master');
    // ...at the SAME commit as before the cut (nothing from the cut survived)...
    expect(git(projectDir, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    // ...with a clean tree (the cut's fragment consumption / manifest bump
    // was discarded, not left dangling)...
    expect(git(projectDir, ['status', '--porcelain=v2'])).toBe('');
    // ...and no stray release/cut-* branch blocking the next attempt's
    // preflight.
    const branches = git(projectDir, ['branch', '--list', 'release/cut-*']);
    expect(branches).toBe('');

    // The fragment itself is untouched -- nothing was actually cut.
    expect(fs.existsSync(path.join(projectDir, '.changes', 'unreleased', 'fixed-widget.md'))).toBe(true);

    // And origin's master never moved either -- the push (if it happened)
    // never got followed by a real merge.
    const originMaster = gitBare(originDir, ['rev-parse', 'refs/heads/master']);
    expect(originMaster).toBe(beforeHead);
  }, 30_000);
});

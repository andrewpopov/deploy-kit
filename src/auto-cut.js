'use strict';

const path = require('path');
const nodeOs = require('os');
const nodeFs = require('fs');
const { normalizeRuntime, shQuote } = require('./exec');
const { log: defaultLog } = require('./log');

// Where the crash-recovery pointer lives, relative to the project root. The
// consumer project is expected to gitignore this (documented in README), same
// spirit as deploy.js's `.deploy-kit-state.json` on the target.
const PENDING_RELEASE_PATH = path.join('.deploy-kit', 'pending-release.json');

const RELEASE_KIT_PACKAGE = '@andrewpopov/release-kit';
const RELEASE_KIT_CONFIG_CANDIDATES = ['release-kit.config.js', 'release-kit.config.cjs'];
const CUT_SCRIPT_NAME = 'release:cut';

// ---- small local helpers ---------------------------------------------------

// Run a shell one-liner on the LOCAL controller checkout (never the deploy
// target -- auto-cut always runs on the machine invoking deploy-kit, before
// either pipeline touches a host). Mirrors exec.js's `sh -c` idiom for
// mode:'local' so the whole module stays testable through the same
// normalizeRuntime seam as every other deploy-kit module, without pulling in
// runOnTarget (which builds ssh/host commands from `config`, not applicable
// here).
function runLocal(runtime, cwd, command, { allowFailure = false, input } = {}) {
  const execOptions = { cwd, encoding: 'utf8' };
  if (input != null) execOptions.input = input;
  try {
    const output = runtime.execFileSync('sh', ['-c', command], execOptions);
    return { ok: true, output: String(output || ''), stderr: '' };
  } catch (error) {
    const result = { ok: false, output: String((error && error.stdout) || ''), stderr: String((error && error.stderr) || ''), error };
    if (!allowFailure) {
      const detail = result.stderr ? `\n${result.stderr}` : '';
      throw new Error(`auto-cut: command failed: ${command}${detail}`);
    }
    return result;
  }
}

function findReleaseKitConfigPath(projectRoot, fsImpl) {
  for (const name of RELEASE_KIT_CONFIG_CANDIDATES) {
    const candidate = path.join(projectRoot, name);
    if (fsImpl.existsSync(candidate)) return candidate;
  }
  return null;
}

function readPendingRelease(projectRoot, fsImpl) {
  const file = path.join(projectRoot, PENDING_RELEASE_PATH);
  if (!fsImpl.existsSync(file)) return null;
  let raw;
  try {
    raw = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`auto-cut: could not read ${PENDING_RELEASE_PATH}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`auto-cut: ${PENDING_RELEASE_PATH} is not valid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed.sha !== 'string' || !parsed.sha) {
    throw new Error(`auto-cut: ${PENDING_RELEASE_PATH} exists but is missing a "sha" — resolve or remove it by hand before retrying`);
  }
  return parsed;
}

// Atomic write (temp file + rename), mirroring release-kit's announced.ts
// `recordAnnouncedVersion` exactly: a crash or short write mid-write must
// never leave a truncated/corrupt pending-release.json, because the whole
// point of this file is resuming an already-published release -- a corrupt
// file fails closed on the very read that exists to make resuming possible.
function writePendingRelease(projectRoot, fsImpl, data) {
  const dir = path.join(projectRoot, '.deploy-kit');
  fsImpl.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(projectRoot, PENDING_RELEASE_PATH);
  const tmpPath = path.join(
    dir,
    `.${path.basename(finalPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fsImpl.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(tmpPath, finalPath);
}

function clearPendingRelease(projectRoot, fsImpl) {
  const file = path.join(projectRoot, PENDING_RELEASE_PATH);
  if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
}

// Fail closed: a release-kit.config.{js,cjs} exists at the project root but
// the package itself is not resolvable from there. Warn-and-skip would
// silently recreate the exact "stale dependency ships under a green deploy"
// defect this feature exists to fix, so this always throws.
function resolveReleaseKit(projectRoot, ctx) {
  const resolve = ctx.resolve || ((name, opts) => require.resolve(name, opts));
  const load = ctx.requireModule || ((modulePath) => require(modulePath));
  let entry;
  try {
    entry = resolve(RELEASE_KIT_PACKAGE, { paths: [projectRoot] });
  } catch {
    throw new Error(
      `auto-cut: release-kit.config was found at the project root but "${RELEASE_KIT_PACKAGE}" is not `
      + `installed/resolvable from there. Run \`npm install ${RELEASE_KIT_PACKAGE}\` in the project, or `
      + 'disable autoCut, before deploying.',
    );
  }
  return load(entry);
}

function loadRkConfig(configPath, ctx) {
  const load = ctx.requireModule || ((modulePath) => require(modulePath));
  const mod = load(configPath);
  const cfg = mod && mod.__esModule ? mod.default : mod;
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`auto-cut: ${configPath} did not export a release-kit config object`);
  }
  return cfg;
}

function isoCompactTimestamp(nowMs) {
  return new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function defaultSleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

const MERGE_POLL_ATTEMPTS = 10;
const MERGE_POLL_DELAY_SECONDS = 3;

// `gh pr merge`'s exit code is never proof of the merge OUTCOME, in either
// direction: success can mean auto-merge was merely enabled/queued (branch
// protection / required checks pending) rather than actually merged, and
// failure can mean a transient network error after the merge already landed
// server-side. So neither exit code is trusted -- this always polls the PR's
// actual state via `gh pr view` (bounded attempts, small delay between, same
// retry idiom as deploy.js's waitForHealth/DB-state reads) until it observes
// state MERGED with a non-empty mergeCommit.oid, or exhausts the bound.
function pollForMergedState(runtime, cwd, prNumber, { sleep = defaultSleep, attempts = MERGE_POLL_ATTEMPTS, delaySeconds = MERGE_POLL_DELAY_SECONDS, log } = {}) {
  let lastState = '(unknown)';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const res = runLocal(runtime, cwd, `gh pr view ${shQuote(String(prNumber))} --json state,mergeCommit -q "(.state)+\\"\\t\\"+(.mergeCommit.oid // \\"\\")"`, { allowFailure: true });
    if (res.ok) {
      const [state, sha] = res.output.trim().split('\t');
      lastState = state || lastState;
      if (state === 'MERGED' && sha) {
        return { merged: true, sha, state };
      }
    }
    if (log && attempt < attempts) {
      log.info(`auto-cut: PR #${prNumber} not yet MERGED (state "${lastState}"); retry in ${delaySeconds}s (${attempt}/${attempts})`);
    }
    if (attempt < attempts) sleep(delaySeconds);
  }
  return { merged: false, sha: null, state: lastState };
}

// ---- preflight --------------------------------------------------------------

function assertNoInProgressGitOperation(runtime, cwd) {
  const script = 'gd=$(git rev-parse --git-dir) || exit 1; '
    + 'test -f "$gd/MERGE_HEAD" && echo merge && exit 0; '
    + 'test -d "$gd/rebase-merge" && echo rebase && exit 0; '
    + 'test -d "$gd/rebase-apply" && echo rebase && exit 0; '
    + 'test -f "$gd/CHERRY_PICK_HEAD" && echo cherry-pick && exit 0; '
    + 'test -f "$gd/REVERT_HEAD" && echo revert && exit 0; '
    + 'test -f "$gd/BISECT_LOG" && echo bisect && exit 0; '
    + 'echo none';
  const res = runLocal(runtime, cwd, script);
  const state = res.output.trim();
  if (state && state !== 'none') {
    throw new Error(`auto-cut: refusing to cut a release with a ${state} in progress on the controller checkout`);
  }
}

function assertCleanWorkingTree(runtime, cwd) {
  const res = runLocal(runtime, cwd, 'git status --porcelain=v2 --ignore-submodules=none');
  if (res.output.trim() !== '') {
    throw new Error('auto-cut: working tree is not clean (tracked, untracked, or submodule changes present); refusing to cut a release from a dirty checkout');
  }
}

function assertOnConfiguredBranch(runtime, cwd, branch) {
  const res = runLocal(runtime, cwd, 'git symbolic-ref -q --short HEAD', { allowFailure: true });
  const current = res.output.trim();
  if (!res.ok || !current) {
    throw new Error('auto-cut: HEAD is detached; auto-cut requires the controller checkout to be on a branch');
  }
  if (current !== branch) {
    throw new Error(`auto-cut: controller checkout is on branch "${current}", expected "${branch}"`);
  }
}

function resolveRemoteDefaultBranch(runtime, cwd, remote) {
  const res = runLocal(runtime, cwd, `git ls-remote --symref ${shQuote(remote)} HEAD`);
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/m.exec(res.output);
  if (!match) {
    throw new Error(`auto-cut: could not determine ${remote}'s default branch from \`git ls-remote --symref\``);
  }
  return match[1];
}

function assertBranchIsRemoteDefault(remoteDefaultBranch, branch) {
  if (remoteDefaultBranch !== branch) {
    throw new Error(`auto-cut: configured branch "${branch}" is not ${'the'} remote's actual default branch ("${remoteDefaultBranch}")`);
  }
}

function fetchAndResolveRemoteTip(runtime, cwd, remote, branch) {
  const fetchRes = runLocal(runtime, cwd, `git fetch ${shQuote(remote)}`, { allowFailure: true });
  if (!fetchRes.ok) {
    throw new Error(`auto-cut: \`git fetch ${remote}\` failed${fetchRes.stderr ? `: ${fetchRes.stderr}` : ''}`);
  }
  const res = runLocal(runtime, cwd, `git rev-parse ${shQuote(remote)}/${shQuote(branch)}`);
  return res.output.trim();
}

function assertLocalHeadMatchesRemoteTip(runtime, cwd, remoteTip) {
  const res = runLocal(runtime, cwd, 'git rev-parse HEAD');
  const localHead = res.output.trim();
  if (localHead !== remoteTip) {
    throw new Error(
      `auto-cut: local HEAD (${localHead.slice(0, 12)}) does not exactly equal the remote tip `
      + `(${remoteTip.slice(0, 12)}) -- a locally-ahead branch would make the eventual fast-forward `
      + 'fail; pull or push first',
    );
  }
}

function assertUnambiguousPushRemote(runtime, cwd, remote) {
  const res = runLocal(runtime, cwd, 'git rev-parse --abbrev-ref --symbolic-full-name @{u}', { allowFailure: true });
  const upstream = res.output.trim();
  if (!res.ok || !upstream.includes('/')) {
    throw new Error('auto-cut: no unambiguous upstream tracking branch configured for HEAD');
  }
  const upstreamRemote = upstream.slice(0, upstream.indexOf('/'));
  if (upstreamRemote !== remote) {
    throw new Error(`auto-cut: HEAD's upstream remote ("${upstreamRemote}") does not match the configured remote ("${remote}")`);
  }
}

function assertGhRepoMatchesRemote(runtime, cwd, remote) {
  const urlRes = runLocal(runtime, cwd, `git remote get-url --push ${shQuote(remote)}`);
  const url = urlRes.output.trim();
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
  if (!match) {
    throw new Error(`auto-cut: could not parse an owner/repo out of ${remote}'s push URL ("${url}")`);
  }
  const [, remoteOwner, remoteRepo] = match;
  const ghRes = runLocal(runtime, cwd, 'gh repo view --json owner,name -q "(.owner.login)+\\"/\\"+(.name)"', { allowFailure: true });
  if (!ghRes.ok) {
    throw new Error(`auto-cut: \`gh repo view\` failed; cannot confirm gh is authenticated against the same repo as ${remote}`);
  }
  const ghSlug = ghRes.output.trim();
  const remoteSlug = `${remoteOwner}/${remoteRepo}`;
  if (ghSlug !== remoteSlug) {
    throw new Error(`auto-cut: \`gh\` resolves repo "${ghSlug}", but the ${remote} remote points at "${remoteSlug}" -- refusing to cut a PR against the wrong repo`);
  }
}

function runPreflight(runtime, cwd, config, remoteDefaultBranch, remoteTip) {
  assertCleanWorkingTree(runtime, cwd);
  assertOnConfiguredBranch(runtime, cwd, config.branch);
  assertBranchIsRemoteDefault(remoteDefaultBranch, config.branch);
  assertNoInProgressGitOperation(runtime, cwd);
  assertLocalHeadMatchesRemoteTip(runtime, cwd, remoteTip);
  assertUnambiguousPushRemote(runtime, cwd, config.remote);
  assertGhRepoMatchesRemote(runtime, cwd, config.remote);
}

// ---- post-cut diff validation ----------------------------------------------

// Parse `git status --porcelain=v2` output into { path, status, from? } rows.
// v2 also reports submodule state on the same line (an 'S...' flags field), so
// this is the one read that covers tracked, untracked, AND submodule changes.
// Formats (see git-status(1)):
//   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
//   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path><TAB><origPath>
//   ? <path>
//   u <XY> <sub> <m1> <m2> <m3> <mW> <hH1> <hI2> <hI3> <path>
const ORDINARY_RE = /^1 \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/;
const RENAME_RE = /^2 \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/;
const UNMERGED_RE = /^u \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/;
function parsePorcelainV2(output) {
  const rows = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const kind = line[0];
    if (kind === '1') {
      const match = ORDINARY_RE.exec(line);
      if (match) rows.push({ path: match[1], status: 'modified' });
    } else if (kind === '2') {
      const match = RENAME_RE.exec(line);
      if (match) {
        const [newPath, oldPath] = match[1].split('\t');
        rows.push({ path: newPath, from: oldPath, status: 'rename' });
      }
    } else if (kind === '?') {
      rows.push({ path: line.slice(3), status: 'untracked' });
    } else if (kind === 'u') {
      const match = UNMERGED_RE.exec(line);
      if (match) rows.push({ path: match[1], status: 'unmerged' });
    }
  }
  return rows;
}

// Build the allowed-path classifier and assert the ACTUAL post-cut diff is
// exactly the expected set: the manifest, the observed fragment paths
// (consumed), the archived copies, and the note/index path(s). Anything else
// aborts naming the unexpected path. Never `git add -A`.
function validateAndStageCutDiff(runtime, cwd, { rootDir, fragments, manifestFiles, notePaths, archiveDirRel }) {
  const statusRes = runLocal(runtime, cwd, 'git status --porcelain=v2 --ignore-submodules=none');
  const rows = parsePorcelainV2(statusRes.output);
  if (rows.length === 0) {
    throw new Error('auto-cut: `npm run release:cut` produced no changes at all -- nothing to commit');
  }

  const fragmentRelPaths = new Set(fragments.map((f) => path.relative(rootDir, f.filePath).split(path.sep).join('/')));
  const manifestSet = new Set(manifestFiles);
  const notePrefixes = notePaths.map((p) => p.replace(/\/+$/, ''));

  const matchesNotePath = (p) => notePrefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
  const matchesArchive = (p) => p === archiveDirRel || p.startsWith(`${archiveDirRel}/`);

  const toStage = [];
  const manifestChanged = [];
  let fragmentsConsumed = 0;
  let archivedCount = 0;
  const noteChanged = [];

  for (const row of rows) {
    const p = row.path;
    if (p.startsWith('../') || path.isAbsolute(p)) {
      throw new Error(`auto-cut: cut diff contains a path escaping the repo root: "${p}"`);
    }
    if (manifestSet.has(p)) {
      manifestChanged.push(p);
      toStage.push(p);
      continue;
    }
    if (row.status === 'rename' && fragmentRelPaths.has(row.from) && matchesArchive(p)) {
      fragmentsConsumed += 1;
      archivedCount += 1;
      toStage.push(p);
      continue;
    }
    if (fragmentRelPaths.has(p)) {
      // Deleted-from-unreleased half of a fragment (matched separately if a
      // rename didn't capture it, e.g. tracked as a plain delete + untracked add).
      fragmentsConsumed += 1;
      toStage.push(p);
      continue;
    }
    if (matchesArchive(p)) {
      archivedCount += 1;
      toStage.push(p);
      continue;
    }
    if (matchesNotePath(p)) {
      noteChanged.push(p);
      toStage.push(p);
      continue;
    }
    throw new Error(`auto-cut: \`npm run release:cut\` touched an unexpected path outside the allowlist: "${p}"`);
  }

  if (manifestChanged.length === 0) {
    throw new Error('auto-cut: `npm run release:cut` did not touch the manifest; expected exactly one manifest advance');
  }
  const manifestPrimary = manifestChanged.filter((p) => !p.endsWith('-lock.json') && !p.endsWith('.lock'));
  if (manifestPrimary.length !== 1) {
    throw new Error(`auto-cut: expected the manifest to advance exactly once, got ${manifestPrimary.length} manifest change(s): ${manifestChanged.join(', ')}`);
  }
  if (fragmentsConsumed !== fragments.length) {
    throw new Error(`auto-cut: expected ${fragments.length} fragment(s) to be consumed, observed ${fragmentsConsumed}`);
  }
  if (fragments.length > 0 && archivedCount !== fragments.length) {
    throw new Error(`auto-cut: expected ${fragments.length} archived fragment copy(ies) under "${archiveDirRel}", observed ${archivedCount}`);
  }
  if (noteChanged.length === 0) {
    throw new Error('auto-cut: `npm run release:cut` did not produce a new release note under the configured note path(s)');
  }

  return { toStage, noteChanged };
}

// ---- local-mode detached temp worktree -------------------------------------

// In `mode: 'local'` the controller checkout IS the deploy target (see
// auto-cut-call.js's comment block), so the cut must never touch it -- a
// failure partway would leave the live checkout on a stray `release/cut-*`
// branch, breaking the in-place deploy that follows. `git worktree add
// --detach <dir> <commit-ish>` shares the commit without claiming the branch
// (unlike a non-detached worktree, which git rejects when the branch is
// already checked out elsewhere), so it is safe to create even while the
// controller sits on `config.branch`. Created OUTSIDE the project directory
// (OS temp dir) so a local-mode deploy -- which pulls from `config.projectDir`
// -- never sees it.
function createLocalCutWorktree(runtime, controllerCwd, repoRootDir, commitish, { tmpdir = nodeOs.tmpdir, now } = {}) {
  const topLevelRes = runLocal(runtime, controllerCwd, 'git rev-parse --show-toplevel');
  const repoTopLevel = topLevelRes.output.trim();
  const relFromTop = path.relative(repoTopLevel, repoRootDir);
  const tmpWorktreeDir = path.join(
    tmpdir(),
    `deploy-kit-autocut-${isoCompactTimestamp(now())}-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  runLocal(runtime, controllerCwd, `git worktree add --detach ${shQuote(tmpWorktreeDir)} ${shQuote(commitish)}`);
  return { tmpWorktreeDir, cutRootDir: relFromTop ? path.join(tmpWorktreeDir, relFromTop) : tmpWorktreeDir };
}

// Always attempted, even after a failure mid-cut -- a leaked worktree blocks
// later `worktree add` calls at the same path and lingers in `git worktree
// list` forever. `allowFailure` on both so cleanup itself never masks (or
// replaces) whatever error is already propagating out of the try block.
function removeLocalCutWorktree(runtime, controllerCwd, tmpWorktreeDir) {
  runLocal(runtime, controllerCwd, `git worktree remove --force ${shQuote(tmpWorktreeDir)}`, { allowFailure: true });
  runLocal(runtime, controllerCwd, 'git worktree prune', { allowFailure: true });
}

// ---- main entry -------------------------------------------------------------

/**
 * Runs on the LOCAL controller checkout, before either deploy pipeline builds
 * a candidate. Produces an immutable merged SHA `R` that the caller then
 * deploys. See AUTOCUT-SPEC.md for the full flow this implements.
 */
function autoCut(config, options = {}, ctx = {}) {
  const log = ctx.log || defaultLog;
  const runtime = normalizeRuntime(ctx.runtime);
  const fsImpl = ctx.fs || nodeFs;
  const now = ctx.now || (() => Date.now());
  const projectRoot = options.projectRoot || process.cwd();
  const dryRun = options.dryRun === true;

  // 1. Skip conditions.
  if (options.autoCut === false || config.autoCut === false) {
    return { ran: false };
  }
  const rkConfigPath = findReleaseKitConfigPath(projectRoot, fsImpl);
  if (!rkConfigPath) {
    return { ran: false };
  }

  // The --branch override guard must run BEFORE the resume check below: a
  // pending release was always cut against config.branch, never a --branch
  // override, so resuming while an override is in play would silently merge/
  // deploy that default-branch release's SHA onto the overridden branch --
  // exactly the prohibition this guard exists to enforce. Checked before ANY
  // preflight or mutation too, dry-run or not.
  if (options.branch) {
    throw new Error('auto-cut: refusing to run with a --branch override in play; auto-cut always targets config.branch on the remote default branch');
  }

  // 10. Resume -- checked before ANY preflight or mutation, dry-run or not:
  // the release may already be published, so re-running must hand back the
  // SAME R, never cut (or deploy a descendant) again.
  const pending = readPendingRelease(projectRoot, fsImpl);
  if (pending) {
    log.info(`auto-cut: resuming pending release ${pending.sha} (PR #${pending.prNumber}) -- not cutting again`);
    return {
      ran: true, resumed: true, sha: pending.sha, version: pending.version, prNumber: pending.prNumber,
    };
  }

  // 3. Fail closed if release-kit itself isn't resolvable -- BEFORE the
  // dry-run branch, so `--dry-run` can never silently skip this the way v1 did.
  const releaseKit = resolveReleaseKit(projectRoot, ctx);
  const rkConfig = loadRkConfig(rkConfigPath, ctx);
  const rkPaths = releaseKit.resolvePaths(rkConfig);
  const rootDir = rkPaths.rootDir;

  // 2. Dry run: report what WOULD be cut, zero local git mutation, zero GitHub write.
  if (dryRun) {
    const fragments = releaseKit.collectFragments(rkConfig);
    log.info(`auto-cut: [dry run] would cut a release from ${fragments.length} fragment(s); performing no local git mutation and no GitHub write`);
    return { ran: false, dryRun: true, fragmentCount: fragments.length };
  }

  // 4. Preflight.
  const remoteDefaultBranch = resolveRemoteDefaultBranch(runtime, rootDir, config.remote);
  const remoteTip = fetchAndResolveRemoteTip(runtime, rootDir, config.remote, config.branch || remoteDefaultBranch);
  runPreflight(runtime, rootDir, config, remoteDefaultBranch, remoteTip);
  const baseTipX = remoteTip;

  // 5. Fragments.
  const fragments = releaseKit.collectFragments(rkConfig);
  if (fragments.length === 0) {
    return { ran: false, fragmentCount: 0 };
  }

  // 6-8. Cut, validate, commit, push, PR, merge. In `mode: 'local'` this all
  // runs in a detached temp worktree, never the controller checkout itself
  // (see createLocalCutWorktree's comment) -- `cutCwd`/`cutRootDir` are the
  // controller checkout (`rootDir`) unchanged in every other mode, so ssh
  // mode's command sequence is untouched. The worktree is always torn down in
  // the `finally`, on every path including a thrown error.
  const isLocalMode = config.mode === 'local';
  let tmpWorktreeDir = null;
  let cutCwd = rootDir;
  let cutRootDir = rootDir;
  let newVersion;
  let mergeState;
  let prNumber;
  try {
    if (isLocalMode) {
      const created = createLocalCutWorktree(runtime, rootDir, rootDir, baseTipX, { now, tmpdir: ctx.tmpdir });
      tmpWorktreeDir = created.tmpWorktreeDir;
      cutCwd = tmpWorktreeDir;
      cutRootDir = created.cutRootDir;
    }

    // 6. Cut on a branch.
    const pkgJsonPath = path.join(cutRootDir, 'package.json');
    let pkgJson;
    try {
      pkgJson = JSON.parse(fsImpl.readFileSync(pkgJsonPath, 'utf8'));
    } catch (error) {
      throw new Error(`auto-cut: could not read ${pkgJsonPath}: ${error.message}`);
    }
    if (!pkgJson.scripts || typeof pkgJson.scripts[CUT_SCRIPT_NAME] !== 'string') {
      throw new Error(
        `auto-cut: project package.json has no "${CUT_SCRIPT_NAME}" script. Install/configure release-kit `
        + `(\`npm install ${RELEASE_KIT_PACKAGE}\` and a "${CUT_SCRIPT_NAME}": "release-kit cut" script) before enabling autoCut.`,
      );
    }

    const cutBranch = `release/cut-${isoCompactTimestamp(now())}`;
    runLocal(runtime, cutCwd, `git checkout -b ${shQuote(cutBranch)}`);
    // Never `npx` -- it could silently fetch a different release-kit version
    // than the one pinned in this project's package.json.
    runLocal(runtime, cutCwd, `npm run ${CUT_SCRIPT_NAME}`);

    // 7. Validate the post-cut diff exactly, then stage ONLY the validated paths.
    const manifestFiles = (config.autoCut && config.autoCut.manifestFiles) || ['package.json', 'package-lock.json'];
    const notesDirRel = path.relative(rootDir, rkPaths.notesDir).split(path.sep).join('/');
    const notePaths = (config.autoCut && config.autoCut.notePaths) || [notesDirRel];
    const archiveDirRel = path.relative(rootDir, rkPaths.archiveDir).split(path.sep).join('/');
    const { toStage, noteChanged } = validateAndStageCutDiff(runtime, cutCwd, {
      rootDir, fragments, manifestFiles, notePaths, archiveDirRel,
    });

    let bumpedPkg;
    try {
      bumpedPkg = JSON.parse(fsImpl.readFileSync(pkgJsonPath, 'utf8'));
    } catch (error) {
      throw new Error(`auto-cut: could not re-read ${pkgJsonPath} after cutting: ${error.message}`);
    }
    newVersion = String(bumpedPkg.version || '').trim();
    if (!newVersion) {
      throw new Error('auto-cut: could not determine the new version from the manifest after cutting');
    }
    const noteContainsVersion = noteChanged.some((rel) => {
      const content = fsImpl.readFileSync(path.join(cutRootDir, rel), 'utf8');
      return content.includes(newVersion);
    });
    if (!noteContainsVersion) {
      throw new Error(`auto-cut: the new release note does not contain the new version "${newVersion}"`);
    }

    runLocal(runtime, cutCwd, `git add -- ${toStage.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(' ')}`);
    runLocal(runtime, cutCwd, `git commit -m ${shQuote(`release: cut ${newVersion}`)}`);
    const cleanRes = runLocal(runtime, cutCwd, 'git status --porcelain=v2 --ignore-submodules=none');
    if (cleanRes.output.trim() !== '') {
      throw new Error('auto-cut: working tree is not clean after committing the cut -- something outside the validated diff was left behind');
    }
    const cutShaRes = runLocal(runtime, cutCwd, 'git rev-parse HEAD');
    const cutSha = cutShaRes.output.trim();

    // 8. Merge with a pre-merge CAS.
    runLocal(runtime, cutCwd, `git push -u ${shQuote(config.remote)} ${shQuote(cutBranch)}`);
    const prTitle = `release: cut ${newVersion}`;
    runLocal(runtime, cutCwd, `gh pr create --base ${shQuote(config.branch)} --head ${shQuote(cutBranch)} --title ${shQuote(prTitle)} --body ${shQuote('Automated release cut by deploy-kit auto-cut.')}`);
    const prNumberRes = runLocal(runtime, cutCwd, `gh pr view ${shQuote(cutBranch)} --json number -q .number`);
    prNumber = Number(prNumberRes.output.trim());
    if (!Number.isFinite(prNumber)) {
      throw new Error(`auto-cut: could not resolve the PR number for ${cutBranch}`);
    }

    const preMergeBaseTip = runLocal(runtime, cutCwd, `git ls-remote ${shQuote(config.remote)} ${shQuote(config.branch)}`).output.split('\t')[0].trim();
    const preMergeHead = runLocal(runtime, cutCwd, `gh pr view ${prNumber} --json headRefOid -q .headRefOid`).output.trim();
    if (preMergeBaseTip !== baseTipX || preMergeHead !== cutSha) {
      runLocal(runtime, cutCwd, `gh pr close ${prNumber} --delete-branch`, { allowFailure: true });
      throw new Error(
        `auto-cut: base "${config.branch}" moved from ${baseTipX.slice(0, 12)} to ${preMergeBaseTip.slice(0, 12)} `
        + 'immediately before merging -- abandoning the PR and branch rather than squashing onto a moved base',
      );
    }

    // `gh pr merge`'s exit code -- success OR failure -- is NOT evidence of the
    // merge OUTCOME: a success can mean auto-merge was merely enabled/queued
    // (branch protection / required checks pending), not that the PR actually
    // merged, and a failure (timeout, transient network error) can mean it
    // succeeded server-side anyway. Never trust the exit code either way --
    // always poll the PR's actual state before concluding anything (spec step
    // 10).
    runLocal(runtime, cutCwd, `gh pr merge ${prNumber} --squash --delete-branch`, { allowFailure: true });
    mergeState = pollForMergedState(runtime, cutCwd, prNumber, { sleep: ctx.sleep || defaultSleep, log });
    if (!mergeState.merged) {
      throw new Error(
        `auto-cut: PR #${prNumber} did not reach state MERGED (observed "${mergeState.state}") within `
        + `${MERGE_POLL_ATTEMPTS} poll attempt(s) -- aborting rather than guessing whether the merge landed`,
      );
    }
  } finally {
    if (tmpWorktreeDir) {
      removeLocalCutWorktree(runtime, rootDir, tmpWorktreeDir);
    }
  }

  // 9. Resolve and persist R BEFORE anything else can fail.
  const mergedSha = mergeState.sha;
  writePendingRelease(projectRoot, fsImpl, {
    sha: mergedSha, version: newVersion, prNumber, at: new Date(now()).toISOString(),
  });

  runLocal(runtime, rootDir, `git fetch ${shQuote(config.remote)} ${shQuote(mergedSha)}`);
  runLocal(runtime, rootDir, `git checkout ${shQuote(config.branch)}`);
  // Fast-forward to R EXPLICITLY, never to the branch tip -- a descendant S
  // landing between the merge and this line must never be silently followed.
  runLocal(runtime, rootDir, `git merge --ff-only ${shQuote(mergedSha)}`);

  // 11. Return R.
  return {
    ran: true, sha: mergedSha, version: newVersion, prNumber, fragmentCount: fragments.length,
  };
}

// Clear the pending-release pointer once the caller's deployment of R has
// actually succeeded -- the resume window closes only then, not at merge time.
function clearAutoCutPending(options = {}, ctx = {}) {
  const fsImpl = ctx.fs || nodeFs;
  const projectRoot = options.projectRoot || process.cwd();
  clearPendingRelease(projectRoot, fsImpl);
}

// Cheap, side-effect-free "would autoCut actually run" check, shared by
// deploy.js/release.js call sites so they can decide -- BEFORE invoking
// autoCut() -- whether local-mode's controller-checkout-is-the-target hazard
// applies (see deploy.js's `localModeAutoCutGuard`). Mirrors autoCut()'s own
// skip conditions (steps 1) exactly; kept in sync by hand since both live in
// this file.
function wouldAutoCutRun(config, options = {}, ctx = {}) {
  if (options.autoCut === false || config.autoCut === false) return false;
  const fsImpl = ctx.fs || nodeFs;
  const projectRoot = options.projectRoot || process.cwd();
  return findReleaseKitConfigPath(projectRoot, fsImpl) != null;
}

module.exports = {
  autoCut,
  clearAutoCutPending,
  wouldAutoCutRun,
  PENDING_RELEASE_PATH,
};

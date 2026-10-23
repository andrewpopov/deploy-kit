'use strict';

// `deploy-kit layout migrate --to releases|legacy [--dry-run]` (BRAIN-636 D9).
//
// Converts a host between the legacy in-place checkout and the release layout, and back. It restructures a
// LIVE app directory, so it only ever RENAMES (never copies, never deletes live data), runs under both owned
// locks, journals every step before taking it, and refuses rather than guesses:
//
//   forward   worktree -> shared -> build -> pointers -> legacy -> marker -> restart -> verify
//   reverse   stop -> legacy -> shared -> unlayout -> restart -> verify
//
// A crash leaves `layout-migrate.journal.json` in the root. A rerun refuses with `layout-migrate-interrupted`
// and prints the commands that undo the journaled steps; it never resumes on its own. The reverse restores the
// layout only: it moves the live shared data back and never reinstates an older untracked-data snapshot, and it
// refuses once a deploy has moved `current` (`layout-reverse-after-deploy`), since that would restore
// pre-cutover code.

const crypto = require('crypto');
const { runOnTarget, shQuote } = require('./exec');
const { acquireOwnedLocks, releaseOwnedLocks, validateOwnedLocks } = require('./lock');
const { stateFiles } = require('./target-state');
const { log: defaultLog } = require('./log');
const {
  LAYOUT_VERSION, releasePaths, waitForHealth, pm2Activate,
} = require('./release');
const { gitInfo } = require('./remote');

const EXIT_OK = 0;
const EXIT_FAILED = 2;
const EXIT_REFUSED = 3;

const JOURNAL_NAME = 'layout-migrate.journal.json';
const LEGACY_DIR = '.legacy-checkout';
const LOCK_WAIT_SECONDS = 30;
const SAFE_ROOT_RE = /^\/[A-Za-z0-9_./-]+$/;
const SAFE_ENTRY_RE = /^[A-Za-z0-9_.@+-]+$/;
const SAFE_ECOSYSTEM_RE = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_LISTED = 20;

const defaultCrash = () => process.kill(process.pid, 'SIGKILL');
function defaultSleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function layoutNames(paths) {
  return {
    journal: `${paths.root}/${JOURNAL_NAME}`,
    legacy: `${paths.root}/${LEGACY_DIR}`,
  };
}

// Names that belong to the release layout (or to this command) and so are never legacy checkout content.
const reservedEntries = (paths) => new Set([
  'repo.git', 'releases', 'shared', 'current', 'previous', LEGACY_DIR, JOURNAL_NAME,
  paths.markerFile.split('/').pop(), paths.stateFile.split('/').pop(),
]);

function makeRunner(config, paths, ctx) {
  const target = { ...config, projectDir: paths.root };
  const read = (command) => {
    const res = runOnTarget(command, target, { capture: true, runtime: ctx.runtime });
    return { ok: res.ok, out: (res.output || '').trim() };
  };
  const mutate = (command) => {
    const res = runOnTarget(command, target, { capture: true, runtime: ctx.runtime });
    if (!res.ok) {
      const detail = (res.stderr || (res.error && res.error.message) || '').trim();
      throw new Error(`command failed: ${command}${detail ? ` (${detail})` : ''}`);
    }
    return res.output.trim();
  };
  return { read, mutate };
}

const inodeOf = (p) => `stat -c %i ${shQuote(p)} 2>/dev/null || stat -f %i ${shQuote(p)}`;
const statLinkedInode = (p) => `stat -L -c %i ${shQuote(p)} 2>/dev/null || stat -L -f %i ${shQuote(p)}`;
const deviceOf = (p) => `stat -c %d ${shQuote(p)} 2>/dev/null || stat -f %d ${shQuote(p)}`;
const writeAtomic = (file, content) => `printf '%s\\n' ${shQuote(content)} > ${shQuote(`${file}.tmp`)} && mv ${shQuote(`${file}.tmp`)} ${shQuote(file)}`;

// ---- preconditions ------------------------------------------------------------------------------

function makeChecklist() {
  const results = [];
  return {
    results,
    add(name, ok, detail = '') { results.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); },
    get ok() { return results.every((r) => r.ok); },
  };
}

function configChecks(config, paths, list) {
  list.add('root-path', SAFE_ROOT_RE.test(paths.root), paths.root);
  list.add('layout-config', config.layout && config.layout.type === 'releases', 'config.layout.type must be "releases"');
  list.add('both-locks', Boolean(config.hostLock) && config.lock !== false,
    'D9 mutations need the host lock and the app lock: configure hostLock and leave lock on');
  list.add('ecosystem-file', typeof config.ecosystemFile === 'string' && SAFE_ECOSYSTEM_RE.test(config.ecosystemFile),
    String(config.ecosystemFile));
  const rels = config.layout && config.layout.sharedPaths;
  list.add('shared-paths-config', Array.isArray(rels), 'config.layout.sharedPaths must be an array');
}

function readJournal(run, paths) {
  const { journal } = layoutNames(paths);
  const raw = run.read(`cat ${shQuote(journal)} 2>/dev/null`);
  if (!raw.out) return null;
  try { return JSON.parse(raw.out); } catch { return { unreadable: true, steps: [] }; }
}

function interruptedGuidance(journal, paths) {
  const done = (journal.steps || []).filter((s) => s.status === 'done' || s.status === 'begun').reverse();
  const undo = done.flatMap((s) => (s.undo || []).map((c) => `  [${s.name}] ${c}`));
  return [
    `A previous layout migration (${journal.direction || 'unknown'}) was interrupted; it will not resume or undo itself.`,
    `Journal: ${layoutNames(paths).journal}`,
    'Inspect the host, then undo the journaled steps by hand, newest first (a step marked "begun" may be partly applied):',
    ...(undo.length ? undo : ['  (no step had begun: the journal can simply be removed)']),
    'Remove the journal only after the host is back in a known layout.',
  ].join('\n');
}

function forwardChecks(config, paths, run) {
  const list = makeChecklist();
  const facts = {};
  configChecks(config, paths, list);
  if (!list.ok) return { list, facts };
  const rels = config.layout.sharedPaths;
  const q = shQuote;

  list.add('marker-absent', run.read(`test -e ${q(paths.markerFile)} && echo present || echo absent`).out === 'absent', paths.markerFile);
  list.add('no-recovery-journal', run.read(`test -e ${q(paths.stateFile)} && echo present || echo absent`).out === 'absent', paths.stateFile);
  const { unresolved } = stateFiles(config);
  list.add('not-unresolved', run.read(`test -e ${unresolved} && echo present || echo absent`).out === 'absent', unresolved);
  const present = run.read(['repo.git', 'releases', 'shared', 'current', 'previous', LEGACY_DIR]
    .map((n) => `{ [ -e ${q(n)} ] || [ -L ${q(n)} ]; } && echo ${n}`).join('; ') + '; true').out;
  list.add('layout-dirs-absent', present === '', present);

  const sha = run.read('git rev-parse HEAD').out;
  const prefix = run.read('git rev-parse --show-prefix 2>/dev/null; echo end').out;
  list.add('git-checkout-at-sha', SHA_RE.test(sha) && prefix === 'end', `HEAD ${sha || '<none>'}`);
  facts.sha = sha;
  const excludes = rels.map((rel) => `:(exclude)${rel}`).map(q).join(' ');
  const dirty = run.read(`git status --porcelain --untracked-files=all -- . ${excludes}`).out;
  list.add('git-clean', dirty === '', dirty.split('\n').slice(0, MAX_LISTED).join('; '));
  const originUrl = run.read(`git config --get ${q(`remote.${config.remote}.url`)}`).out;
  list.add('remote-url', originUrl !== '', `remote ${config.remote}`);
  facts.originUrl = originUrl;
  const ignored = run.read('git ls-files --others --ignored --exclude-standard --directory').out;
  list.add('ignored-untracked-reported', true,
    `not carried into the new release (only sharedPaths are shared; a rebuild recreates the rest): ${ignored.split('\n').filter(Boolean).slice(0, MAX_LISTED).join(', ') || 'none'}`);

  facts.inodes = {};
  rels.forEach((rel) => {
    const tracked = run.read(`git ls-files --error-unmatch -- ${q(rel)} >/dev/null 2>&1 && echo tracked || echo untracked`).out;
    const kind = run.read(`if [ -L ${q(rel)} ]; then echo symlink; elif [ -e ${q(rel)} ]; then echo exists; else echo missing; fi`).out;
    const sameDevice = kind === 'exists' && run.read(deviceOf(rel)).out === run.read(deviceOf('.')).out;
    list.add(`shared-path:${rel}`, tracked === 'untracked' && kind === 'exists' && sameDevice,
      `${tracked}, ${kind}${kind === 'exists' && !sameDevice ? ', on another filesystem (mv would copy)' : ''}`);
    facts.inodes[rel] = run.read(inodeOf(rel)).out;
  });

  const eco = config.ecosystemFile;
  const ecoOk = run.read(`[ -f ${q(eco)} ] && grep -qF ${q(`${paths.root}/current`)} ${q(eco)} && echo ok`).out === 'ok';
  list.add('ecosystem-cwd-current', ecoOk, `${eco} must exist and name ${paths.root}/current`);

  const reserved = reservedEntries(paths);
  facts.entries = run.read('ls -A').out.split('\n').filter((e) => e && !reserved.has(e));
  const badEntry = facts.entries.find((e) => !SAFE_ENTRY_RE.test(e));
  list.add('entry-names', badEntry === undefined, badEntry || '');
  return { list, facts };
}

function reverseChecks(config, paths, run) {
  const list = makeChecklist();
  const facts = {};
  configChecks(config, paths, list);
  if (!list.ok) return { list, facts };
  const q = shQuote;
  const { legacy } = layoutNames(paths);

  const markerRaw = run.read(`cat ${q(paths.markerFile)} 2>/dev/null`).out;
  let marker = null;
  try { marker = JSON.parse(markerRaw); } catch { marker = null; }
  const migration = marker && marker.layout === 'releases' && marker.version === LAYOUT_VERSION ? marker.migration : null;
  list.add('marker-records-migration', Boolean(migration && SHA_RE.test(migration.sha) && migration.releaseId),
    markerRaw ? 'marker has no D9 migration record (a hand-migrated host cannot be reversed here)' : `${paths.markerFile} is missing`);
  if (!migration) return { list, facts };
  facts.migration = migration;
  facts.sha = migration.sha;

  const { unresolved } = stateFiles(config);
  list.add('not-unresolved', run.read(`test -e ${unresolved} && echo present || echo absent`).out === 'absent', unresolved);
  list.add('no-recovery-journal', run.read(`test -e ${q(paths.stateFile)} && echo present || echo absent`).out === 'absent', paths.stateFile);

  const current = run.read(`readlink ${q(paths.currentLink)}`).out;
  const previous = run.read(`readlink ${q(paths.previousLink)}`).out;
  const currentSha = run.read(`cd ${q(paths.currentLink)} && git rev-parse HEAD`).out;
  facts.currentSha = currentSha;
  const stillMigrated = current === `releases/${migration.releaseId}` && currentSha === migration.sha && previous === '';
  list.add('no-deploy-since-forward', stillMigrated,
    `current ${current || '<none>'} at ${currentSha || '<unknown>'}, previous ${previous || '<none>'}; forward left releases/${migration.releaseId} at ${migration.sha}`);
  facts.afterDeploy = !stillMigrated;

  const legacySha = run.read(`cd ${q(legacy)} && git rev-parse HEAD`).out;
  list.add('legacy-checkout-at-sha', legacySha === migration.sha, `${LEGACY_DIR} HEAD ${legacySha || '<none>'}`);
  const entries = run.read(`ls -A ${q(legacy)}`).out.split('\n').filter(Boolean);
  facts.entries = entries;
  const eco = migration.ecosystemFile;
  const collisions = entries.filter((e) => e !== eco.split('/')[0] && run.read(`{ [ -e ${q(e)} ] || [ -L ${q(e)} ]; } && echo yes`).out === 'yes');
  list.add('no-entry-collisions', collisions.length === 0, collisions.join(', '));
  const ecoSame = run.read(`cmp -s ${q(eco)} ${q(`${LEGACY_DIR}/${eco}`)} && echo same || echo differs`).out === 'same';
  list.add('stable-ecosystem-unmodified', ecoSame, `${eco} differs from the legacy copy: reconcile by hand`);

  facts.inodes = {};
  migration.sharedPaths.forEach((rel) => {
    const link = run.read(`readlink ${q(`${LEGACY_DIR}/${rel}`)}`).out;
    const live = run.read(`[ -e ${q(`shared/${rel}`)} ] && echo yes`).out === 'yes';
    list.add(`shared-path:${rel}`, live && link === `${paths.root}/shared/${rel}`, `shared data ${live ? 'present' : 'missing'}, legacy link ${link || '<none>'}`);
    facts.inodes[rel] = run.read(inodeOf(`shared/${rel}`)).out;
  });
  return { list, facts };
}

// ---- plans --------------------------------------------------------------------------------------

function forwardPlan(config, paths, facts, releaseId) {
  const q = shQuote;
  const { legacy } = layoutNames(paths);
  const releaseDir = `${paths.releasesDir}/${releaseId}`;
  const rels = config.layout.sharedPaths;
  const eco = config.ecosystemFile;
  const installEnv = `npm_config_cache=${paths.npmCache}`;
  const buildCommands = [
    `cd ${q(releaseDir)} && ${installEnv} ${config.hooks.install}`,
    ...(config.hooks.generate ? [`cd ${q(releaseDir)} && ${config.hooks.generate}`] : []),
    ...(config.hooks.build ? [`cd ${q(releaseDir)} && ${config.hooks.build}`] : []),
  ];
  const marker = {
    layout: 'releases',
    version: LAYOUT_VERSION,
    migration: {
      sha: facts.sha, releaseId, sharedPaths: rels, ecosystemFile: eco, at: new Date().toISOString(),
    },
  };
  return {
    marker,
    steps: [
      {
        name: 'worktree',
        commands: [
          `mkdir ${q(paths.releasesDir)}`,
          `git clone --bare --quiet ${q(`${paths.root}/.git`)} ${q(paths.repoGit)}`,
          `git --git-dir=${q(paths.repoGit)} config ${q(`remote.${config.remote}.url`)} ${q(facts.originUrl)}`,
          `git --git-dir=${q(paths.repoGit)} worktree add --detach ${q(releaseDir)} ${facts.sha}`,
        ],
        undo: [`git --git-dir=${paths.repoGit} worktree remove --force ${releaseDir}`, `rm -r ${paths.repoGit}`, `rmdir ${paths.releasesDir}`],
      },
      {
        name: 'shared',
        commands: [
          `mkdir ${q(paths.sharedDir)}`,
          ...rels.flatMap((rel) => [
            `mkdir -p "$(dirname ${q(`${paths.sharedDir}/${rel}`)})"`,
            `mv ${q(`${paths.root}/${rel}`)} ${q(`${paths.sharedDir}/${rel}`)}`,
            `ln -s ${q(`${paths.sharedDir}/${rel}`)} ${q(`${paths.root}/${rel}`)}`,
            `mkdir -p "$(dirname ${q(`${releaseDir}/${rel}`)})"`,
            `{ [ ! -e ${q(`${releaseDir}/${rel}`)} ] && [ ! -L ${q(`${releaseDir}/${rel}`)} ]; } || exit 1`,
            `ln -s ${q(`${paths.sharedDir}/${rel}`)} ${q(`${releaseDir}/${rel}`)}`,
          ]),
        ],
        undo: rels.map((rel) => `rm ${paths.root}/${rel} && mv ${paths.sharedDir}/${rel} ${paths.root}/${rel}`),
      },
      { name: 'build', commands: buildCommands, undo: ['nothing to undo (the release is removed by the worktree step)'] },
      {
        name: 'pointers',
        commands: [`ln -s ${q(`releases/${releaseId}`)} ${q(paths.currentLink)}`],
        undo: [`rm ${paths.currentLink}`],
      },
      {
        name: 'legacy',
        commands: [
          `mkdir ${q(legacy)}`,
          ...facts.entries.map((e) => `mv ${q(`${paths.root}/${e}`)} ${q(`${legacy}/${e}`)}`),
          `mkdir -p "$(dirname ${q(`${paths.root}/${eco}`)})"`,
          `cp -p ${q(`${legacy}/${eco}`)} ${q(`${paths.root}/${eco}`)}`,
        ],
        undo: [
          `rm ${paths.root}/${eco}`,
          ...facts.entries.map((e) => `mv ${legacy}/${e} ${paths.root}/${e}`),
          `rmdir ${legacy}`,
        ],
      },
      {
        name: 'marker',
        commands: [writeAtomic(paths.markerFile, JSON.stringify(marker))],
        undo: [`rm ${paths.markerFile}`],
      },
      { name: 'restart', commands: [pm2Activate(config, paths)], undo: ['(restart the app from the legacy ecosystem once the tree is restored)'] },
    ],
  };
}

function reversePlan(config, paths, facts) {
  const q = shQuote;
  const { legacy } = layoutNames(paths);
  const { migration } = facts;
  const eco = migration.ecosystemFile;
  const stop = `pm2 stop ${config.appNames.map(q).join(' ')}`;
  return {
    steps: [
      { name: 'stop', commands: [stop], undo: ['pm2 start the app again from the release ecosystem'] },
      {
        name: 'legacy',
        commands: [
          `rm ${q(`${paths.root}/${eco}`)}`,
          `d=${q(eco)}; d=$(dirname "$d"); while [ "$d" != . ]; do rmdir ${q(paths.root)}/"$d" 2>/dev/null || break; d=$(dirname "$d"); done; true`,
          ...facts.entries.map((e) => `mv ${q(`${legacy}/${e}`)} ${q(`${paths.root}/${e}`)}`),
          `rmdir ${q(legacy)}`,
        ],
        undo: ['move the restored entries back into .legacy-checkout (names: ' + facts.entries.join(', ') + ')'],
      },
      {
        name: 'shared',
        commands: migration.sharedPaths.map((rel) => {
          const link = `${paths.root}/${rel}`;
          const data = `${paths.sharedDir}/${rel}`;
          return `{ [ -L ${q(link)} ] && [ "$(readlink ${q(link)})" = ${q(data)} ]; } || exit 1; rm ${q(link)} && mv ${q(data)} ${q(link)}`;
        }),
        undo: migration.sharedPaths.map((rel) => `mv ${paths.root}/${rel} ${paths.sharedDir}/${rel} && ln -s ${paths.sharedDir}/${rel} ${paths.root}/${rel}`),
      },
      {
        name: 'unlayout',
        commands: [
          `rm ${q(paths.markerFile)}`,
          `{ [ ! -L ${q(paths.currentLink)} ] || rm ${q(paths.currentLink)}; }`,
          `{ [ ! -L ${q(paths.previousLink)} ] || rm ${q(paths.previousLink)}; }`,
        ],
        undo: [`restore ${paths.markerFile} (the journal records the migration record) and ln -s releases/${migration.releaseId} ${paths.currentLink}`],
      },
      {
        name: 'restart',
        commands: [config.hooks.restart || pm2Activate(config, paths)],
        undo: ['(restart the app by hand)'],
      },
    ],
  };
}

// ---- execution ----------------------------------------------------------------------------------

function execute({ direction, plan, run, paths, crashAt, sha, extraJournal }) {
  const { journal: journalFile } = layoutNames(paths);
  const journal = { version: 1, direction, sha, startedAt: new Date().toISOString(), ...extraJournal, steps: [] };
  const flush = () => run.mutate(writeAtomic(journalFile, JSON.stringify(journal)));
  flush();
  const results = [];
  plan.steps.forEach((step) => {
    const entry = { name: step.name, status: 'begun', undo: step.undo };
    journal.steps.push(entry);
    flush();
    crashAt(`layout-${step.name}`);
    step.commands.forEach((command) => run.mutate(command));
    entry.status = 'done';
    flush();
    results.push({ name: step.name, status: 'done', commands: step.commands });
  });
  return { results, finish: () => run.mutate(`rm -f ${shQuote(journalFile)}`) };
}

function verifyForward({ config, paths, run, ctx, facts, releaseId }) {
  const q = shQuote;
  const failures = [];
  let marker = null;
  try { marker = JSON.parse(run.read(`cat ${q(paths.markerFile)}`).out); } catch { marker = null; }
  if (!marker || marker.layout !== 'releases' || marker.version !== LAYOUT_VERSION) failures.push('marker does not parse');
  if (run.read(`readlink ${q(paths.currentLink)}`).out !== `releases/${releaseId}`) failures.push('current does not point at the new release');
  const currentSha = run.read(`cd ${q(paths.currentLink)} && git rev-parse HEAD`).out;
  if (currentSha !== facts.sha) failures.push(`current resolves to ${currentSha || '<none>'}, expected ${facts.sha}`);
  if (!waitForHealth(config, ctx)) failures.push('health never returned 200');
  Object.entries(facts.inodes).forEach(([rel, inode]) => {
    const now = run.read(statLinkedInode(`${paths.currentLink}/${rel}`)).out;
    if (now !== inode) failures.push(`shared path ${rel} is inode ${now || '<none>'}, was ${inode} (moved data must keep its inode)`);
  });
  return failures;
}

function verifyReverse({ config, paths, run, ctx, facts }) {
  const failures = [];
  const head = run.read('git rev-parse HEAD').out;
  if (head !== facts.sha) failures.push(`HEAD is ${head || '<none>'}, expected ${facts.sha}`);
  if (!gitInfo(config, { log: ctx.log, runtime: ctx.runtime })) failures.push('deploy-kit git could not read the checkout');
  if (!waitForHealth(config, ctx)) failures.push('health never returned 200');
  Object.entries(facts.inodes).forEach(([rel, inode]) => {
    const now = run.read(inodeOf(`${paths.root}/${rel}`)).out;
    if (now !== inode) failures.push(`shared path ${rel} is inode ${now || '<none>'}, was ${inode} (moved data must keep its inode)`);
  });
  return failures;
}

function refusal(direction, code, message, extra = {}) {
  return { exitCode: EXIT_REFUSED, result: { direction, sha: null, steps: [], verified: false, refused: code, message, ...extra } };
}

// -> { exitCode, result } with result { direction, sha, steps, verified, ... }.
function migrateLayout(config, { to, dryRun = false } = {}, deps = {}) {
  if (to !== 'releases' && to !== 'legacy') throw new Error('deploy-kit: layout migrate needs --to releases|legacy');
  const direction = to === 'releases' ? 'forward' : 'reverse';
  const env = deps.env || process.env;
  const ctx = {
    runtime: deps.runtime, sleep: deps.sleep || defaultSleep, log: deps.log || defaultLog,
  };
  const crash = deps.crash || defaultCrash;
  const crashAt = (point) => { if (env.DEPLOY_KIT_TEST_CRASH_AT === point) crash(point); };
  const paths = releasePaths(config);
  const run = makeRunner(config, paths, ctx);

  let handle = null;
  if (!dryRun) {
    const configProblems = makeChecklist();
    configChecks(config, paths, configProblems);
    const bad = configProblems.results.find((r) => !r.ok);
    if (bad) return refusal(direction, 'layout-precondition-failed', `precondition ${bad.name} failed: ${bad.detail}`, { preconditions: configProblems.results });
    try {
      handle = acquireOwnedLocks(config, ctx, {
        notAfter: Date.now() / 1000 + LOCK_WAIT_SECONDS,
        runId: crypto.randomUUID(),
        purpose: 'layout-migrate',
        sleep: ctx.sleep,
      });
    } catch (error) {
      return refusal(direction, 'layout-lock-held', `could not take the host and app locks: ${error.message}`);
    }
  }
  try {
    const journal = readJournal(run, paths);
    if (journal) {
      return refusal(direction, 'layout-migrate-interrupted', interruptedGuidance(journal, paths), { journal });
    }
    const { list, facts } = direction === 'forward' ? forwardChecks(config, paths, run) : reverseChecks(config, paths, run);
    if (direction === 'reverse' && facts.afterDeploy) {
      return refusal(direction, 'layout-reverse-after-deploy',
        'a deploy has run since the forward migration: reversing would restore pre-cutover code over a possibly migrated database. '
        + 'Keep the maintenance hold and assess recovery explicitly.', { preconditions: list.results });
    }
    if (!list.ok) {
      const failed = list.results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`).join('; ');
      return refusal(direction, 'layout-precondition-failed', `refused: ${failed}`, { preconditions: list.results });
    }
    const releaseId = direction === 'forward' ? `${facts.sha.slice(0, 12)}-${run.read('date -u +%Y%m%dT%H%M%SZ').out}` : null;
    const plan = direction === 'forward' ? forwardPlan(config, paths, facts, releaseId) : reversePlan(config, paths, facts);
    const planned = plan.steps.map((s) => ({ name: s.name, commands: s.commands }));

    if (dryRun) {
      return {
        exitCode: EXIT_OK,
        result: {
          direction, sha: facts.sha, steps: planned, verified: false, dryRun: true, preconditions: list.results,
        },
      };
    }

    validateOwnedLocks(config, ctx, handle);
    const extraJournal = direction === 'forward' ? { releaseId, marker: plan.marker } : { migration: facts.migration };
    let executed;
    try {
      executed = execute({
        direction, plan, run, paths, crashAt, sha: facts.sha, extraJournal,
      });
    } catch (error) {
      if (error && error.isCrash) throw error;
      return {
        exitCode: EXIT_FAILED,
        result: {
          direction, sha: facts.sha, steps: planned, verified: false, failed: error.message, journal: layoutNames(paths).journal,
        },
      };
    }
    const failures = direction === 'forward'
      ? verifyForward({ config, paths, run, ctx, facts, releaseId })
      : verifyReverse({ config, paths, run, ctx, facts });
    if (failures.length) {
      return {
        exitCode: EXIT_FAILED,
        result: {
          direction, sha: facts.sha, steps: executed.results, verified: false, failed: failures.join('; '), journal: layoutNames(paths).journal,
        },
      };
    }
    executed.finish();
    return { exitCode: EXIT_OK, result: { direction, sha: facts.sha, steps: executed.results, verified: true } };
  } finally {
    if (handle) releaseOwnedLocks(handle);
  }
}

module.exports = {
  migrateLayout, JOURNAL_NAME, LEGACY_DIR, EXIT_OK, EXIT_FAILED, EXIT_REFUSED,
};

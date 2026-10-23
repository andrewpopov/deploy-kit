import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import {
  makeTarget, requestMeta, deployResult, runIdN, KIT_ARTIFACT, LIVE_SHA, REQUEST_ID, OTHER_REQUEST_ID, Target,
} from './on-host-fixture';
import { hasFlock } from './target-state-fixture';

const require = createRequire(__filename);
const lock = require('../lock.js');
const kit = require('../index.js');
const release = require('../release.js');
const { requestMeta: operatorRequestMeta } = require('../on-host/operator.js');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const describeWithFlock = hasFlock ? describe : describe.skip;

const PREVIOUS_SHA = 'e'.repeat(40);
const CURRENT_ID = 'cccccccccccc-20260709T090000Z';
const PREVIOUS_ID = 'eeeeeeeeeeee-20260708T090000Z';

let t: Target;
beforeEach(() => { t = makeTarget(); });
afterEach(() => t.cleanup());

const rollbackMeta = (over: Record<string, unknown> = {}) => requestMeta({ kind: 'rollback', sha: PREVIOUS_SHA, rollbackTo: PREVIOUS_SHA, ...over });

// current -> releases/<CURRENT_ID> (carrying `record`, unless null), previous -> releases/<PREVIOUS_ID>; each release's sha in `.sha`.
function layOut(record: unknown | null = { sha: LIVE_SHA, migrated: false, migrationsPending: 0, backupId: null }, previousSha = PREVIOUS_SHA) {
  const root = t.config.projectDir;
  for (const [id, sha] of [[CURRENT_ID, LIVE_SHA], [PREVIOUS_ID, previousSha]]) {
    fs.mkdirSync(path.join(root, 'releases', id), { recursive: true });
    fs.writeFileSync(path.join(root, 'releases', id, '.sha'), sha);
  }
  if (record !== null) {
    fs.writeFileSync(path.join(root, 'releases', CURRENT_ID, '.deploy-kit-release.json'), typeof record === 'string' ? record : JSON.stringify(record));
  }
  fs.symlinkSync(`releases/${CURRENT_ID}`, path.join(root, 'current'));
  fs.symlinkSync(`releases/${PREVIOUS_ID}`, path.join(root, 'previous'));
}
const gitSeam = { readReleaseSha: (dir: string) => fs.readFileSync(path.join(dir, '.sha'), 'utf8') };
const flipAndRestart = (_c: unknown, _o: unknown, ctx: { onStep: (e: { step: string; class: string }) => void }) => {
  ctx.onStep({ step: 'current-pointer', class: 'live' });
  ctx.onStep({ step: 'pm2-restart', class: 'live' });
  return deployResult({ stage: 'done' });
};

function expectRefused(runId: string, code: string, run: { code: number; rollbackRelease: unknown; deployRelease: unknown }) {
  expect(run.code).toBe(1);
  expect(run.rollbackRelease).not.toHaveBeenCalled();
  expect(run.deployRelease).not.toHaveBeenCalled();
  expect(t.readJson(`runs/${runId}/refused.json`)).toEqual({ runId, code });
  expect(t.has(`runs/${runId}/accepted.json`)).toBe(false);
  expect(t.has(`runs/${runId}/terminal.json`)).toBe(false);
  expect(t.has(`requests/${REQUEST_ID}.json`)).toBe(false);
  expect(t.lockLeft()).toEqual([]);
}

describeWithFlock('rollback --on-host: accepted like a deploy', () => {
  it('rolls back to previous: owned locks, no staging fetch, ledger of the live steps, terminal.json carries the rollback result', () => {
    layOut();
    const runId = runIdN(1);
    t.stage(runId, rollbackMeta());
    const run = t.go(runId, { rollbackPipeline: flipAndRestart, git: gitSeam });
    expect(run.code).toBe(0);
    expect(run.deployRelease).not.toHaveBeenCalled();
    expect(t.events).toEqual(['readLive', 'rollback-pipeline', 'readLive']);
    expect(run.git.stage).not.toHaveBeenCalled();
    const [, , ctx] = run.rollbackRelease.mock.calls[0];
    expect(ctx.ownedLocks).toMatchObject({ runId, pid: process.pid });
    expect(t.readJson(`runs/${runId}/accepted.json`)).toMatchObject({ runId, requestId: REQUEST_ID, kind: 'rollback', sha: PREVIOUS_SHA, gen: 1 });
    expect(t.readJson(`requests/${REQUEST_ID}.json`)).toMatchObject({ state: 'accepted', runId, liveBefore: LIVE_SHA });
    expect(t.readJson(`runs/${runId}/terminal.json`)).toEqual({
      runId,
      kind: 'rollback',
      result: deployResult({ liveBefore: LIVE_SHA, liveAfter: LIVE_SHA }),
      effects: [{ step: 'current-pointer', class: 'live' }, { step: 'pm2-restart', class: 'live' }],
      kitArtifact: KIT_ARTIFACT,
      finishedAt: '2026-10-23T10:00:00.000Z',
    });
    expect(t.has('deploy-kit-' + lock.lockId(t.config) + '.unresolved.json')).toBe(false);
    expect(t.lockLeft()).toEqual([]);
    expect(t.status(runId).state).toBe('terminal');
  });

  it('a rollback that fails after its live steps writes the unresolved marker before terminal.json', () => {
    layOut();
    const runId = runIdN(1);
    t.stage(runId, rollbackMeta());
    const failing = (c: unknown, o: unknown, ctx: any) => {
      flipAndRestart(c, o, ctx);
      throw Object.assign(new Error('Rollback target was unhealthy'), { deployResult: deployResult({ status: 'failed-unrecovered', error: 'Rollback target was unhealthy', recovery: { action: 'manual', verified: false } }) });
    };
    const run = t.go(runId, { rollbackPipeline: failing, git: gitSeam });
    expect(run.code).toBe(1);
    expect(t.readJson(`runs/${runId}/terminal.json`)).toMatchObject({ kind: 'rollback', result: { status: 'failed-unrecovered' } });
    expect(t.readJson('deploy-kit-' + lock.lockId(t.config) + '.unresolved.json')).toMatchObject({ requestId: REQUEST_ID, runId, kind: 'rollback', status: 'failed-unrecovered' });
  });
});

describeWithFlock('rollback --on-host: kind gates', () => {
  it('--to that is not previous refuses rollback-target-mismatch', () => {
    layOut();
    t.stage(runIdN(1), rollbackMeta({ sha: 'f'.repeat(40), rollbackTo: 'f'.repeat(40) }));
    expectRefused(runIdN(1), 'rollback-target-mismatch', t.go(runIdN(1), { git: gitSeam }));
  });

  it('no previous release refuses rollback-target-mismatch', () => {
    layOut();
    fs.rmSync(path.join(t.config.projectDir, 'previous'));
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'rollback-target-mismatch', t.go(runIdN(1), { git: gitSeam }));
  });

  it('a current release that migrated refuses rollback-across-migration', () => {
    layOut({ sha: LIVE_SHA, migrated: true, migrationsPending: 2, backupId: 'b1' });
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'rollback-across-migration', t.go(runIdN(1), { git: gitSeam }));
  });

  it('a current release with no release record is treated as migrated: refuses rollback-across-migration', () => {
    layOut(null);
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'rollback-across-migration', t.go(runIdN(1), { git: gitSeam }));
  });

  it('an unreadable release record is treated as migrated', () => {
    layOut('{not json');
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'rollback-across-migration', t.go(runIdN(1), { git: gitSeam }));
  });

  it('an interrupted journal refuses recovery-pending before the rollback gates', () => {
    layOut();
    fs.writeFileSync(path.join(t.config.projectDir, '.deploy-kit-state.json'), JSON.stringify({ phase: 'stopped', releaseId: 'r1' }));
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'recovery-pending', t.go(runIdN(1), { git: gitSeam }));
  });

  it('a terminal journal passes', () => {
    layOut();
    fs.writeFileSync(path.join(t.config.projectDir, '.deploy-kit-state.json'), JSON.stringify({ phase: 'done', releaseId: 'r1' }));
    t.stage(runIdN(1), rollbackMeta());
    expect(t.go(runIdN(1), { rollbackPipeline: flipAndRestart, git: gitSeam }).code).toBe(0);
  });
});

describeWithFlock('rollback --on-host: the common gates apply', () => {
  it('epoch: a fenced target refuses a mismatched epoch', () => {
    layOut();
    t.put('.last-epoch', '5\n');
    t.stage(runIdN(1), rollbackMeta({ epoch: 4 }));
    expectRefused(runIdN(1), 'epoch-mismatch', t.go(runIdN(1), { git: gitSeam }));
  });

  it('hold: an active hold refuses', () => {
    layOut();
    t.put('deploy-kit-' + lock.lockId(t.config) + '.hold.json', { reason: 'cutover', until: null, at: 'x', epoch: null });
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'hold', t.go(runIdN(1), { git: gitSeam }));
  });

  it('reservation: expecting a clean abort that is not there refuses reservation-missing', () => {
    layOut();
    t.stage(runIdN(1), rollbackMeta({ expectReservation: { state: 'clean-abort', runId: runIdN(9), gen: 1 } }));
    expectRefused(runIdN(1), 'reservation-missing', t.go(runIdN(1), { git: gitSeam }));
  });

  it('reservation: a request already executed refuses request-executed', () => {
    layOut();
    t.putReservation({ runId: runIdN(9) });
    t.putTerminal(runIdN(9), { status: 'deployed' });
    t.stage(runIdN(1), rollbackMeta());
    const run = t.go(runIdN(1), { git: gitSeam });
    expect(run.code).toBe(1);
    expect(run.rollbackRelease).not.toHaveBeenCalled();
    expect(t.readJson(`runs/${runIdN(1)}/refused.json`)).toEqual({ runId: runIdN(1), code: 'request-executed' });
    expect(t.has(`runs/${runIdN(1)}/accepted.json`)).toBe(false);
  });

  it('app-unresolved: an unresolved marker refuses', () => {
    layOut();
    t.put('deploy-kit-' + lock.lockId(t.config) + '.unresolved.json', { requestId: OTHER_REQUEST_ID, runId: runIdN(8), kind: 'deploy', status: 'failed', at: 'x' });
    t.stage(runIdN(1), rollbackMeta());
    expectRefused(runIdN(1), 'app-unresolved', t.go(runIdN(1), { git: gitSeam }));
  });
});

describe('rollback --on-host: the operator request', () => {
  const options = (over: Record<string, unknown> = {}) => ({
    kind: 'rollback', request: REQUEST_ID, epoch: '0', notAfter: '1790000000', expectReservation: '{"state":"none","runId":null,"gen":0}',
    sha: PREVIOUS_SHA, rollbackTo: PREVIOUS_SHA, ...over,
  });
  it('carries rollbackTo for a rollback and for nothing else', () => {
    expect(operatorRequestMeta({}, options())).toMatchObject({ kind: 'rollback', rollbackTo: PREVIOUS_SHA });
    expect(operatorRequestMeta({}, options({ kind: 'deploy', rollbackTo: undefined }))).not.toHaveProperty('rollbackTo');
    expect(() => operatorRequestMeta({}, options({ kind: 'deploy' }))).toThrow(/--to is only valid for a rollback/);
  });
  it('refuses a --to that is not a full sha', () => {
    expect(() => operatorRequestMeta({}, options({ rollbackTo: 'abc123', sha: 'abc123' }))).toThrow(/40 lowercase hex/);
  });
});

describeWithFlock('rollback --on-host: the host refuses a malformed request', () => {
  it('a rollback whose rollbackTo is missing or differs from sha never reaches the gates', () => {
    layOut();
    t.stage(runIdN(1), rollbackMeta({ rollbackTo: undefined }));
    const first = t.go(runIdN(1), { git: gitSeam });
    expect(first.code).toBe(1);
    expect(first.rollbackRelease).not.toHaveBeenCalled();
    t.stage(runIdN(2), rollbackMeta({ rollbackTo: 'f'.repeat(40) }));
    expect(t.go(runIdN(2), { git: gitSeam }).code).toBe(1);
    expect(t.logs.error.mock.calls.join()).toContain('meta.rollbackTo');
  });
});

// ---- the deploy path writes the release record --------------------------------------------------------------------

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CURRENT = 'releases/00000000aaaa-20260709T090000Z';
const PREVIOUS = 'releases/00000000bbbb-20260708T090000Z';

function deployWith(pending: string) {
  const calls: string[] = [];
  let stopped = false;
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    // The owned-lock handle (an onHost.required app only deploys with one): the lock scripts and their read-backs.
    if (/pwd -P/.test(cmd)) return '/canonical/app.lock\n{"nonce":"n1","runId":"r1"}\n';
    if (/cat ".*\/nonce" 2>\/dev\/null$/.test(cmd)) return 'n1\n';
    if (cmd.includes('check-pending')) return pending;
    if (/pm2 stop /.test(cmd)) { stopped = true; return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { stopped = false; return ''; }
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('rev-parse')) return SHA;
    if (cmd.includes('readlink -f')) return '/srv/app/releases/a1b2c3d4e5f6-20260710T090000Z';
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 111, pm2_env: { status: stopped ? 'stopped' : 'online', restart_time: 5 } }]);
    if (cmd.includes('readlink ') && cmd.includes('/current')) return CURRENT;
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return PREVIOUS;
    if (cmd.includes('ls -1')) return 'a1b2c3d4e5f6-20260710T090000Z\n00000000aaaa-20260709T090000Z\n00000000bbbb-20260708T090000Z';
    if (cmd.includes('get-running-sha')) return SHA;
    if (cmd.includes('run-backup')) return '/var/lib/app/backups/app-20260710T090000Z.db.gpg';
    if (cmd.includes('curl')) return '200';
    return '';
  };
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
    ecosystemFile: 'shared/ecosystem.config.cjs', health: { attempts: 2, delaySeconds: 0 }, onHost: { required: true },
    hooks: {
      install: 'npm ci', build: 'npm run build', backup: 'run-backup', migrate: 'run-migrate', restore: 'run-restore',
      pendingMigrations: 'check-pending', migrationsExclusive: true,
    },
    layout: { type: 'releases', keepReleases: 4, sharedPaths: ['.env'], releaseChecks: [], runningShaCommand: 'get-running-sha' },
  });
  const runtime = { execFileSync };
  const ownedLocks = lock.acquireOwnedLocks(cfg, { runtime }, { notAfter: 9999999999, runId: 'r1', purpose: 'deploy', kind: 'unit' });
  calls.length = 0;
  release.deployRelease(cfg, {}, { runtime, ownedLocks, sleep: () => {}, now: () => Date.parse('2026-07-10T09:00:00Z') });
  const write = calls.find((cmd) => cmd.includes('.deploy-kit-release.json'));
  const flip = calls.findIndex((cmd) => /mv -Tf .*\/current$/.test(cmd) || (cmd.includes('ln -s') && cmd.includes('releases/') && cmd.endsWith('/current')));
  return { write, calls, written: write ? JSON.parse(/printf '%s\\n' '(.*?)' >/s.exec(write)![1]) : null, flip };
}

describe('the deploy writes the release record before `current` flips', () => {
  it('probe-zero path: migrated false, migrationsPending 0', () => {
    const out = deployWith('0\n');
    expect(out.written).toEqual({ sha: SHA, migrated: false, migrationsPending: 0, backupId: null });
    expect(out.calls.some((cmd) => cmd.includes('run-migrate'))).toBe(false);
    expect(out.calls.indexOf(out.write!)).toBeLessThan(out.flip);
  });

  it('migrate path: migrated true, with the pending count and the backup id', () => {
    const out = deployWith('3\n');
    expect(out.written).toMatchObject({ sha: SHA, migrated: true, migrationsPending: 3 });
    expect(out.written.backupId).toEqual(expect.any(String));
    expect(out.calls.some((cmd) => cmd.includes('run-migrate'))).toBe(true);
    expect(out.calls.indexOf(out.write!)).toBeLessThan(out.flip);
  });
});

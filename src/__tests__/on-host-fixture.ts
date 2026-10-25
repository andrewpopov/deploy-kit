// Shared by on-host-gate.test.ts and reservation.test.ts (BRAIN-636 D4a): a fake target HOME with a staged
// run dir per run, host-run driven in-process with a fake pipeline and fake git, real locks and real
// records, and D5's onHostStatus reading them back through `sh` against the same HOME.
import { vi } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(__filename);
const { hostRun } = require('../on-host/host-run.js');
const { CrashSeam } = require('../on-host/accept.js');
const { onHostStatus } = require('../on-host/status.js');
const lock = require('../lock.js');

export { CrashSeam };
export const NOW_MS = Date.parse('2026-10-23T10:00:00Z');
export const NOW_SEC = NOW_MS / 1000;
export const SHA = 'a'.repeat(40);
export const LIVE_SHA = 'c'.repeat(40);
export const REQUEST_ID = 'req-deploy-gateapp-20261023-2-e0';
export const OTHER_REQUEST_ID = 'req-deploy-gateapp-20261023-3-e0';
export const runIdN = (n: number) => `20261023T10000${n}Z-0123456789ab-0000000${n}`;
const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

export const KIT_ARTIFACT = { version: '0.33.0', sha256: 'd'.repeat(64) };

export type Meta = Record<string, unknown>;

// A well-formed DeployResult (src/deploy-result.js); a test overrides only the fields it is about.
export const deployResult = (over: Meta = {}): Record<string, unknown> => ({
  status: 'deployed', stage: 'done', liveBefore: null, liveAfter: null, migrated: false, migrationsPending: null, backupId: null,
  effectsClean: null, recovery: { action: 'none', verified: false }, error: null, ...over,
});

export function requestMeta(over: Meta = {}): Meta {
  return {
    kind: 'deploy', requestId: REQUEST_ID, parentRequestId: null, parentRunId: null, epoch: 0, notAfter: NOW_SEC + 3600,
    expectReservation: { state: 'none', runId: null, gen: 0 }, kitArtifact: KIT_ARTIFACT, ...over,
  };
}

export function makeTarget() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-gate-'));
  fs.mkdirSync(path.join(home, 'hosts'));
  fs.mkdirSync(path.join(home, 'proj'));
  fs.mkdirSync(path.join(home, 'bin'));
  fs.writeFileSync(path.join(home, 'bin', 'systemctl'), '#!/bin/sh\necho "ActiveState=inactive"\necho "SubState=dead"\n', { mode: 0o755 });
  const config = {
    mode: 'local', layout: { type: 'releases' }, lock: true, stepTimeoutSeconds: 60, localShell: '/bin/sh', appNames: ['gateapp'],
    projectDir: path.join(home, 'proj'), remote: 'origin', onHost: { required: true }, hostLock: { dir: path.join(home, 'hosts'), key: 'bigpi' },
    preDeployChecks: [] as Array<{ name: string; command: string }>,
  };
  const runtime = {
    execFileSync: (file: string, args: string[], opts: any = {}) => realExecFileSync(file, args, {
      ...opts, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }),
  };
  const statusRuntime = {
    execFileSync: (_file: string, args: string[]) => realExecFileSync('sh', ['-c', args[args.length - 1]], {
      encoding: 'utf8', env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, HOME: home, XDG_RUNTIME_DIR: '/tmp' },
    }),
  };
  const dk = (rel: string) => path.join(home, '.deploy-kit', rel);
  const runDirOf = (runId: string) => dk(`runs/${runId}`);
  const has = (rel: string) => fs.existsSync(dk(rel));
  const readJson = (rel: string) => JSON.parse(fs.readFileSync(dk(rel), 'utf8'));
  const put = (rel: string, content: unknown) => {
    fs.mkdirSync(path.dirname(dk(rel)), { recursive: true });
    fs.writeFileSync(dk(rel), typeof content === 'string' ? content : JSON.stringify(content));
  };
  const lockLeft = () => [lock.lockDir(config).replace('$HOME', home), lock.hostLockDir(config)].filter((dir: string) => fs.existsSync(dir));

  // Stage a run dir the way the operator's upload does. `meta` is the request fields (null = none, the pre-request flow).
  function stage(runId: string, meta: Meta | null = requestMeta(), configOver: Record<string, unknown> = {}) {
    const runDir = runDirOf(runId);
    fs.mkdirSync(path.join(runDir, 'kit', 'src'), { recursive: true });
    fs.chmodSync(runDir, 0o700);
    fs.writeFileSync(path.join(runDir, 'kit', 'package.json'), '{}');
    fs.writeFileSync(path.join(runDir, 'kit', 'src', 'cli.js'), '//');
    const full = {
      runId, sha: SHA, options: { skipBuild: true, verifyPins: false }, operatorVersion: '0.33.0', operatorConfigSha256: 'b'.repeat(64),
      operatorGitHead: 'c'.repeat(40), createdAt: '2026-10-23T09:59:00Z',
      capture: { path: '/usr/bin', umask: '0022', oomScoreAdj: 100, shell: '/bin/sh', env: {} }, ...(meta || {}),
    };
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(full));
    fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify({ ...config, ...configOver }));
    const files = ['kit/package.json', 'kit/src/cli.js', 'config.json', 'meta.json'];
    fs.writeFileSync(path.join(runDir, 'manifest.sha256'), files.map((f) => `${sha256(fs.readFileSync(path.join(runDir, f)))}  ${f}`).join('\n') + '\n');
    return runDir;
  }

  const logs = { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn(), step: vi.fn() };
  const events: string[] = [];
  let clock = NOW_MS;
  const setClock = (ms: number) => { clock = ms; };
  const advance = (seconds: number) => { clock += seconds * 1000; };

  // What each seam observed, for the ordering assertions.
  const snapshots: Array<{ at: string; accepted: boolean; reservation: boolean }> = [];
  const snap = (at: string, runId: string) => snapshots.push({
    at, accepted: fs.existsSync(path.join(runDirOf(runId), 'accepted.json')), reservation: fs.existsSync(dk(`requests/${REQUEST_ID}.json`)),
  });

  interface GoOptions {
    pipeline?: (cfg: any, opts: any, ctx: any) => unknown;
    rollbackPipeline?: (cfg: any, opts: any, ctx: any) => unknown;
    recoverPipeline?: (cfg: any, opts: any, ctx: any) => unknown;
    crashAt?: string;
    env?: Record<string, string | undefined>;
    git?: Record<string, unknown>;
    deps?: Record<string, unknown>;
  }
  function go(runId: string, { pipeline, rollbackPipeline, recoverPipeline, crashAt, env, git, deps }: GoOptions = {}) {
    const deployRelease = vi.fn((cfg: any, opts: any, ctx: any) => {
      events.push('pipeline');
      snap('pipeline', runId);
      if (ctx) lock.validateOwnedLocks(cfg, { runtime }, ctx.ownedLocks); // the handle must be live and whole
      return pipeline ? pipeline(cfg, opts, ctx) : undefined;
    });
    const rollbackRelease = vi.fn((cfg: any, opts: any, ctx: any) => {
      events.push('rollback-pipeline');
      snap('rollback-pipeline', runId);
      if (ctx) lock.validateOwnedLocks(cfg, { runtime }, ctx.ownedLocks);
      return rollbackPipeline ? rollbackPipeline(cfg, opts, ctx) : undefined;
    });
    const recoverRelease = vi.fn((cfg: any, opts: any, ctx: any) => {
      events.push('recover-pipeline');
      snap('recover-pipeline', runId);
      if (ctx) lock.validateOwnedLocks(cfg, { runtime }, ctx.ownedLocks);
      return recoverPipeline ? recoverPipeline(cfg, opts, ctx) : undefined;
    });
    const fakeGit = {
      stage: vi.fn(() => { events.push('stage'); snap('stage', runId); }),
      readLive: vi.fn(() => { events.push('readLive'); snap('readLive', runId); return LIVE_SHA; }),
      isAncestor: vi.fn(() => { events.push('isAncestor'); snap('isAncestor', runId); return true; }),
      ...git,
    };
    const code = hostRun(runDirOf(runId), {
      deployRelease, rollbackRelease, recoverRelease, git: fakeGit, runtime, sleep: () => advance(60),
      crash: () => { throw new CrashSeam('crash'); },
      runCheck: () => ({ ok: true }),
      env: {
        INVOCATION_ID: 'a'.repeat(32), HOME: home, USER: 'u', PM2_HOME: '/pm2', ...(crashAt ? { DEPLOY_KIT_TEST_CRASH_AT: crashAt } : {}), ...env,
      },
      log: logs, readOomScoreAdj: () => '100\n', readFile: () => '42', run: () => '42', now: () => new Date(clock), ...deps,
    });
    return { code, deployRelease, rollbackRelease, recoverRelease, git: fakeGit };
  }
  const status = (runId: string, requestId: string | undefined = REQUEST_ID) => onHostStatus(
    { mode: 'ssh', host: 'dkapp@host', projectDir: config.projectDir, appNames: config.appNames, stepTimeoutSeconds: 60 },
    runId, { requestId, runtime: statusRuntime },
  );
  // A finished run's terminal record, written by hand for the reservation table.
  const putTerminal = (runId: string, result: Record<string, unknown>) => put(`runs/${runId}/terminal.json`, {
    runId, kind: 'deploy', result: deployResult(result), effects: null, kitArtifact: KIT_ARTIFACT, finishedAt: '2026-10-23T09:00:00Z',
  });
  const putReservation = (over: Record<string, unknown> = {}) => put(`requests/${REQUEST_ID}.json`, {
    requestId: REQUEST_ID, gen: 1, state: 'accepted', runId: runIdN(1), at: '2026-10-23T09:00:00Z', liveBefore: LIVE_SHA, prev: null, ...over,
  });
  // An accepted run elsewhere on the host that names the request.
  const putAcceptedRun = (runId: string, requestId = REQUEST_ID) => {
    put(`runs/${runId}/meta.json`, { runId, requestId });
    put(`runs/${runId}/accepted.json`, { runId });
  };

  return {
    home, config, runtime, dk, has, readJson, put, lockLeft, stage, go, status, logs, events, snapshots, clock: { set: setClock, advance },
    putTerminal, putReservation, putAcceptedRun, runDirOf,
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

export type Target = ReturnType<typeof makeTarget>;

// Shared by target-state.test.ts and request-cancel.test.ts: a temp HOME standing in for the app user's
// home on the target, and a runtime that runs each remote command for real in `sh` against it (mode
// 'local', so the same code path as ssh minus the transport).
import { createRequire } from 'module';
import { execFileSync as realExecFileSync, spawnSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as any;
const lock = require('../lock.js') as typeof import('../lock');

export const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;
export const hasProc = existsSync('/proc/self/stat');

export const RUN_ID = '20261023T103000Z-0123456789ab-deadbeef';
export const OTHER_RUN_ID = '20261023T110000Z-0123456789ab-cafebabe';
export const REQUEST_ID = 'req-deploy-app-20261023-2-e0';

const homes: string[] = [];
export function cleanupHomes() {
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
}

export function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-kit-d3-'));
  homes.push(dir);
  return dir;
}

export function runtimeFor(home: string, extraEnv: Record<string, string> = {}) {
  const execFileSync = (file: string, args: string[], opts: any = {}) => realExecFileSync(file, args, {
    ...opts, env: { ...process.env, HOME: home, ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { execFileSync };
}

export const appConfig = (over: Record<string, unknown> = {}) => kit.mergeConfig(kit.DEFAULT_CONFIG, {
  mode: 'local', appNames: ['d3app'], autoCut: false, ...over,
});

export const dkPath = (home: string, rel: string) => join(home, '.deploy-kit', rel);
export const lockPathFor = (config: any, home: string) => lock.lockDir(config).replace('$HOME', home);

export function put(home: string, rel: string, content: unknown) {
  const file = dkPath(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}
export const read = (home: string, rel: string) => readFileSync(dkPath(home, rel), 'utf8');
export const readJson = (home: string, rel: string) => JSON.parse(read(home, rel));
export const exists = (home: string, rel: string) => existsSync(dkPath(home, rel));

// A lock held by someone else, through the real acquire.
export function holdAppLock(config: any, home: string, runId = 'someone-else') {
  const optedIn = { ...config, onHost: { required: true } };
  return lock.acquireLock(optedIn, { runtime: runtimeFor(home) }, { kind: 'unit', runId, purpose: 'deploy' });
}

// A `node` ahead of the real one on PATH that records who started it, then execs the real node. The
// lock session test uses it to see the one waited-for child that `request cancel` runs while validating.
// Returns the env to give runtimeFor() and the file the shim appends `<ppid> <sid>` to.
export function nodeShim(home: string, ownerFile: string) {
  const dir = join(home, 'shim-bin');
  const log = join(home, 'node-shim.log');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'node');
  writeFileSync(shim, [
    '#!/bin/sh',
    'sid=; [ -e /proc/self/stat ] && sid=$(ps -o sid= -p $$ | tr -d " ")',
    `echo "$(ps -o ppid= -p $$ | tr -d ' ') $sid $(cat ${JSON.stringify(ownerFile)} 2>/dev/null | tr -d '\\n')" >> ${JSON.stringify(log)}`,
    `exec ${JSON.stringify(process.execPath)} "$@"`,
  ].join('\n'), { mode: 0o755 });
  return { env: { PATH: `${dir}:${process.env.PATH}` }, log };
}

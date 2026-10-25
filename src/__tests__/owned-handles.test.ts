import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const lock = require('../lock.js') as typeof import('../lock');
const release = require('../release.js');
const { mergeConfig, DEFAULT_CONFIG } = kit as any;

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

const homes: string[] = [];
function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-kit-owned-'));
  homes.push(dir);
  mkdirSync(join(dir, 'hosts'));
  mkdirSync(join(dir, 'proj'));
  mkdirSync(join(dir, 'proj2'));
  return dir;
}
afterEach(() => {
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

function runtimeFor(home: string, commands: string[] = []) {
  const execFileSync = (file: string, args: string[], opts: any = {}) => {
    commands.push(args[args.length - 1]);
    return realExecFileSync(file, args, {
      ...opts, env: { ...process.env, HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  return { execFileSync };
}

const configFor = (home: string, over: any = {}) => mergeConfig(DEFAULT_CONFIG, {
  mode: 'local',
  appNames: ['owned-app'],
  projectDir: join(home, 'proj'),
  autoCut: false,
  layout: { type: 'releases' },
  hostLock: { dir: join(home, 'hosts'), key: 'bigpi' },
  ...over,
});

const appLock = (home: string) => join(home, '.deploy-kit', `deploy-kit-${lock.lockId(configFor(home))}.lock`);
const hostLock = (home: string) => join(home, 'hosts', 'bigpi.lock');
const take = (home: string, config = configFor(home), ctx: any = { runtime: runtimeFor(home) }) => (
  lock.acquireOwnedLocks(config, ctx, { notAfter: 1000, runId: 'run-1', purpose: 'deploy' })
);
const rejected = /owned lock handle rejected/;

describeOnPosix('owned lock handles: validation', () => {
  it('accepts the handle it issued, with canonical paths and both nonces', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    expect(handle).toMatchObject({ runId: 'run-1', pid: process.pid, released: false });
    expect(handle.hostNonce).toMatch(/\S/);
    expect(handle.appNonce).toMatch(/\S/);
    expect(handle.hostPath?.endsWith('/hosts/bigpi.lock')).toBe(true);
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).not.toThrow();
    lock.releaseOwnedLocks(handle);
  });

  it('rejects a copied object', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    const copy = JSON.parse(JSON.stringify(handle));
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, copy)).toThrow(rejected);
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, { ...handle })).toThrow(rejected);
    lock.releaseOwnedLocks(handle);
  });

  it('rejects a released handle, and release removes both lock dirs', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    lock.releaseOwnedLocks(handle);
    expect(existsSync(appLock(home))).toBe(false);
    expect(existsSync(hostLock(home))).toBe(false);
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).toThrow(/already released/);
  });

  it('rejects a handle issued to another pid', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    handle.pid = process.pid + 1;
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).toThrow(/pid/);
    handle.pid = process.pid;
    lock.releaseOwnedLocks(handle);
  });

  it('rejects a path that is not the one the config derives', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    const other = configFor(home, { hostLock: { dir: join(home, 'hosts'), key: 'otherhost' } });
    mkdirSync(join(home, 'hosts', 'otherhost.lock'));
    expect(() => lock.validateOwnedLocks(other, { runtime: runtimeFor(home) }, handle)).toThrow(rejected);
    rmSync(join(home, 'hosts', 'otherhost.lock'), { recursive: true });
    handle.appPath = `${handle.appPath}-elsewhere`;
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).toThrow(/path/);
    handle.appPath = appLock(home);
    lock.releaseOwnedLocks(handle);
  });

  it('rejects an owner file on disk that carries another nonce or run id', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    const ownerFile = join(hostLock(home), 'owner');
    const original = readFileSync(ownerFile, 'utf8');

    writeFileSync(ownerFile, original.replace(handle.hostNonce as string, 'someone-elses-nonce'));
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).toThrow(/owner on disk/);

    writeFileSync(ownerFile, original.replace('"run-1"', '"run-2"'));
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).toThrow(/owner on disk/);

    writeFileSync(ownerFile, original);
    const appOwner = join(appLock(home), 'owner');
    const appOriginal = readFileSync(appOwner, 'utf8');
    writeFileSync(appOwner, appOriginal.replace(handle.appNonce as string, 'someone-elses-nonce'));
    expect(() => lock.validateOwnedLocks(config, { runtime: runtimeFor(home) }, handle)).toThrow(/owner on disk/);
    writeFileSync(appOwner, appOriginal);
    lock.releaseOwnedLocks(handle);
  });

  it('rejects a partial handle (host lock missing, or app lock missing)', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    const ctx = { runtime: runtimeFor(home) };

    const hostPath = handle.hostPath;
    handle.hostPath = null;
    expect(() => lock.validateOwnedLocks(config, ctx, handle)).toThrow(/partial/);
    handle.hostPath = hostPath;

    const appPath = handle.appPath;
    handle.appPath = null as any;
    expect(() => lock.validateOwnedLocks(config, ctx, handle)).toThrow(/partial/);
    handle.appPath = appPath;

    const hostless = take(home, configFor(home, { hostLock: null, projectDir: join(home, 'proj2') }), ctx);
    expect(() => lock.validateOwnedLocks(config, ctx, hostless)).toThrow(/partial/);
    lock.releaseOwnedLocks(handle);
    lock.releaseOwnedLocks(hostless);
  });

  it('removes a lock only when its nonce still matches', () => {
    const home = freshHome();
    const handle = take(home);
    writeFileSync(join(hostLock(home), 'nonce'), 'someone-elses-nonce\n');
    lock.releaseOwnedLocks(handle);
    expect(existsSync(appLock(home))).toBe(false);
    expect(existsSync(hostLock(home))).toBe(true);
  });
});

describeOnPosix('deployRelease with ctx.ownedLocks', () => {
  const lockCommands = (commands: string[]) => commands.filter((c) => /mkdir -m 700|rm -rf/.test(c) && /\.lock/.test(c));

  it('does not touch the lock dirs when the handle is valid, and leaves them held', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    const commands: string[] = [];
    const ctx = { runtime: runtimeFor(home, commands), sleep: () => {}, ownedLocks: handle };

    // The project dir does not exist, so the pipeline fails in preflight, after the lock step.
    let error: Error | null = null;
    try { release.deployRelease(config, { skipBuild: true, verifyPins: false }, ctx); } catch (e) { error = e as Error; }

    expect(error).not.toBeNull();
    expect(error!.message).not.toMatch(rejected);
    expect(commands.length).toBeGreaterThan(0);
    expect(lockCommands(commands)).toEqual([]);
    expect(existsSync(appLock(home))).toBe(true);
    expect(existsSync(hostLock(home))).toBe(true);
    lock.releaseOwnedLocks(handle);
  });

  it('refuses a copied handle before running anything', () => {
    const home = freshHome();
    const config = configFor(home);
    const handle = take(home, config);
    const commands: string[] = [];
    const ctx = { runtime: runtimeFor(home, commands), sleep: () => {}, ownedLocks: { ...handle } };
    expect(() => release.deployRelease(config, { skipBuild: true, verifyPins: false }, ctx)).toThrow(rejected);
    expect(lockCommands(commands)).toEqual([]);
    expect(existsSync(appLock(home))).toBe(true);
    lock.releaseOwnedLocks(handle);
  });

  it('without a handle still takes and releases the app lock itself', () => {
    const home = freshHome();
    const config = configFor(home, { hostLock: null });
    const commands: string[] = [];
    const ctx = { runtime: runtimeFor(home, commands), sleep: () => {} };
    expect(() => release.deployRelease(config, { skipBuild: true, verifyPins: false }, ctx)).toThrow();
    const locks = lockCommands(commands);
    expect(locks.some((c) => c.includes('mkdir -m 700'))).toBe(true);
    expect(locks.some((c) => c.includes('rm -rf'))).toBe(true);
    expect(existsSync(appLock(home))).toBe(false);
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { execFileSync as realExecFileSync } from 'child_process';
import {
  mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, lstatSync, statSync, readlinkSync, symlinkSync, realpathSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const lock = require('../lock.js') as typeof import('../lock');
const { migrateLayout } = require('../layout-migrate.js');
const { mergeConfig, DEFAULT_CONFIG } = kit as any;

// Each case builds a real git repo and runs the migration through real shell commands.
vi.setConfig({ testTimeout: 60000 });

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

const LAYOUT_ENTRIES = ['repo.git', 'releases', 'shared', 'current', 'previous', '.legacy-checkout', '.deploy-kit-layout', 'layout-migrate.journal.json'];
const FORWARD_STEPS = ['worktree', 'shared', 'build', 'pointers', 'legacy', 'marker', 'restart'];

const homes: string[] = [];
afterEach(() => {
  while (homes.length) rmSync(homes.pop() as string, { recursive: true, force: true });
});

const cleanEnv = (home: string) => {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  Object.keys(env).filter((k) => k.startsWith('GIT_') && !/^GIT_(AUTHOR|COMMITTER)_/.test(k)).forEach((k) => delete env[k]);
  return env as NodeJS.ProcessEnv;
};
const git = (home: string, cwd: string, ...args: string[]) => realExecFileSync('git', args, { cwd, env: cleanEnv(home), encoding: 'utf8' }).trim();

interface Fixture {
  home: string; root: string; config: any; commands: string[]; lockSeen: string[]; health: { code: string };
  runtime: any; deps: (over?: any) => any; sha: string;
  pm2: { cwd: string | null; files: string[]; forceCwd: string | null; status: string; pid: number; procCwd: string | null };
}

function fixture(configOver: any = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'dk-layout-'));
  homes.push(home);
  mkdirSync(join(home, 'hosts'));
  const origin = join(home, 'origin.git');
  const root = join(home, 'app');
  git(home, home, 'init', '--bare', '--quiet', origin);
  git(home, home, 'clone', '--quiet', origin, root);
  writeFileSync(join(root, 'package.json'), '{"name":"app"}\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'index.js'), 'console.log(1)\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  writeFileSync(join(root, 'ecosystem.config.cjs'), `module.exports = { apps: [{ name: 'app', cwd: '${root}/current' }] };\n`);
  writeFileSync(join(root, 'ecosystem.legacy.config.cjs'), `module.exports = { apps: [{ name: 'app', cwd: '${root}' }] };\n`);
  git(home, root, 'add', '-A');
  git(home, root, 'commit', '--quiet', '-m', 'init');
  git(home, root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/master');
  // Live, untracked state: a file and a directory share-listed, plus an ignored dependency tree.
  writeFileSync(join(root, '.env'), 'SECRET=1\n');
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'db.sqlite'), 'rows');
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'dep.js'), 'x');

  const config = mergeConfig(DEFAULT_CONFIG, {
    mode: 'local',
    appNames: ['app'],
    projectDir: root,
    autoCut: false,
    ecosystemFile: 'ecosystem.config.cjs',
    layout: { type: 'releases', sharedPaths: ['.env', 'data'], legacyEcosystemFile: 'ecosystem.legacy.config.cjs' },
    hostLock: { dir: join(home, 'hosts'), key: 'bigpi' },
    hooks: { install: 'true', build: 'true' },
    health: { attempts: 1, delaySeconds: 0 },
    stepTimeoutSeconds: 60,
    ...configOver,
  });
  const commands: string[] = [];
  const lockSeen: string[] = [];
  const health = { code: '200' };
  // A pm2 that keeps the cwd a process was first started with (stop and startOrRestart do not move it); only
  // `pm2 delete` followed by a start takes the cwd from the ecosystem file given.
  const pm2 = { cwd: null as string | null, files: [] as string[], forceCwd: null as string | null, status: 'online', pid: 4242, procCwd: null as string | null };
  const lockOwners = () => [
    join(home, '.deploy-kit', `deploy-kit-${lock.lockId(config)}.lock`, 'owner'),
    join(home, 'hosts', 'bigpi.lock', 'owner'),
  ];
  const runtime = {
    execFileSync: (file: string, args: string[], opts: any = {}) => {
      const cmd = args[args.length - 1];
      commands.push(cmd);
      if (cmd.includes('pm2 jlist')) {
        const cwd = pm2.forceCwd || pm2.cwd;
        return JSON.stringify(cwd ? [{ name: 'app', pid: pm2.pid, pm_cwd: cwd, pm2_env: { status: pm2.status, pm_cwd: cwd } }] : []);
      }
      // Linux /proc is not there on the test machine: a live process runs from the cwd pm2 started it with.
      if (cmd.includes('readlink -f /proc/')) return realpathSync(pm2.procCwd || pm2.forceCwd || pm2.cwd || '/');
      if (/pm2 (startOrRestart|stop)/.test(cmd)) {
        if (cmd.includes('pm2 delete')) pm2.cwd = null;
        const file = /startOrRestart '?([^' ]+)'?/.exec(cmd);
        if (file) {
          pm2.files.push(file[1]);
          if (pm2.cwd === null) pm2.cwd = /cwd: '([^']+)'/.exec(readFileSync(file[1], 'utf8'))![1];
        }
        lockSeen.push(lockOwners().every((f) => existsSync(f)) ? 'both' : 'missing');
        return '';
      }
      if (cmd.includes('curl -f -s')) return health.code;
      return realExecFileSync(file, args, { ...opts, env: cleanEnv(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    },
  };
  const silent = { header() {}, info() {}, step() {}, success() {}, warning() {}, error() {}, divider() {} };
  const deps = (over: any = {}) => ({ runtime, sleep: () => {}, log: silent, env: {}, ...over });
  return {
    home, root, config, commands, lockSeen, health, runtime, deps, sha: git(home, root, 'rev-parse', 'HEAD'), pm2,
  };
}

// Every path under root (excluding .git internals) with its kind, inode and symlink target, so a move that
// was really a copy, or a dry run that touched anything, shows up as a difference.
function snapshot(root: string, skip: string[] = []): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    readdirSync(dir).sort().forEach((name) => {
      const r = rel ? `${rel}/${name}` : name;
      if (!rel && skip.includes(name)) return;
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) { out.push(`${r} -> ${readlinkSync(full)}`); return; }
      out.push(`${r} ${st.isDirectory() ? 'dir' : 'file'} ino=${st.ino}`);
      if (st.isDirectory() && name !== '.git') walk(full, r);
    });
  };
  walk(root, '');
  return out;
}

const preconditionFailed = (result: any, name: string) => (result.preconditions || []).filter((p: any) => !p.ok).map((p: any) => p.name).includes(name);
const crashSeam = () => { throw Object.assign(new Error('crash'), { isCrash: true }); };

describeOnPosix('layout migrate: forward', () => {
  it('moves a legacy checkout to the release layout, verified, with the data in place', () => {
    const f = fixture();
    const before = { env: statSync(join(f.root, '.env')).ino, data: statSync(join(f.root, 'data')).ino };
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(result).toMatchObject({ direction: 'forward', sha: f.sha, verified: true });
    expect(exitCode).toBe(0);
    expect(result.steps.map((s: any) => s.name)).toEqual(FORWARD_STEPS);
    const marker = JSON.parse(readFileSync(join(f.root, '.deploy-kit-layout'), 'utf8'));
    expect(marker).toMatchObject({ layout: 'releases', version: 1, migration: { sha: f.sha, sharedPaths: ['.env', 'data'] } });
    expect(readlinkSync(join(f.root, 'current'))).toBe(`releases/${marker.migration.releaseId}`);
    expect(existsSync(join(f.root, 'previous'))).toBe(false);
    expect(git(f.home, join(f.root, 'current'), 'rev-parse', 'HEAD')).toBe(f.sha);
    expect(git(f.home, join(f.root, '.legacy-checkout'), 'rev-parse', 'HEAD')).toBe(f.sha);
    expect(existsSync(join(f.root, '.legacy-checkout', 'node_modules', 'dep.js'))).toBe(true);
    expect(existsSync(join(f.root, 'layout-migrate.journal.json'))).toBe(false);
    expect(f.commands.filter((c) => /pm2 startOrRestart/.test(c))[0]).toContain(`${f.root}/ecosystem.config.cjs`);
    // Moved, not copied: the shared files are the very inodes that were live, and current sees them.
    expect(statSync(join(f.root, 'shared', '.env')).ino).toBe(before.env);
    expect(statSync(join(f.root, 'shared', 'data')).ino).toBe(before.data);
    expect(statSync(join(f.root, 'current', 'data')).ino).toBe(before.data);
    expect(readFileSync(join(f.root, 'current', 'data', 'db.sqlite'), 'utf8')).toBe('rows');
  });

  it('takes the host and app locks for the whole run and releases them after', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(f.lockSeen).toEqual(['both']);
    expect(existsSync(join(f.home, 'hosts', 'bigpi.lock'))).toBe(false);
    expect(existsSync(join(f.home, '.deploy-kit', `deploy-kit-${lock.lockId(f.config)}.lock`))).toBe(false);
  });

  it('refuses when a lock is already held', () => {
    const f = fixture({ onHost: { required: true } });
    mkdirSync(join(f.home, 'hosts', 'bigpi.lock'));
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases' }, f.deps({ sleep: () => {} }));
    expect(exitCode).toBe(3);
    expect(result.refused).toBe('layout-lock-held');
  });

  it('exits 2 and keeps the journal when verification fails', () => {
    const f = fixture();
    f.health.code = '503';
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.verified).toBe(false);
    expect(result.failed).toMatch(/health never returned 200/);
    expect(existsSync(join(f.root, 'layout-migrate.journal.json'))).toBe(true);
  });

  const refusals: Array<[string, string, (f: Fixture) => void, any?]> = [
    ['a marker already exists', 'marker-absent', (f) => writeFileSync(join(f.root, '.deploy-kit-layout'), '{}')],
    ['the checkout has an uncommitted change', 'git-clean', (f) => writeFileSync(join(f.root, 'src', 'index.js'), 'dirty\n')],
    ['the checkout has an untracked file outside sharedPaths', 'git-clean', (f) => writeFileSync(join(f.root, 'stray.txt'), 'x')],
    ['a deploy recovery journal exists', 'no-recovery-journal', (f) => writeFileSync(join(f.root, '.deploy-kit-state.json'), '{"phase":"flipped"}')],
    ['the app is unresolved', 'not-unresolved', (f) => {
      mkdirSync(join(f.home, '.deploy-kit'), { recursive: true });
      writeFileSync(join(f.home, '.deploy-kit', `deploy-kit-${lock.lockId(f.config)}.unresolved.json`), '{}');
    }],
    ['a layout directory is already present', 'layout-dirs-absent', (f) => mkdirSync(join(f.root, 'releases'))],
    ['a shared path is missing', 'shared-path:data', (f) => rmSync(join(f.root, 'data'), { recursive: true })],
    ['the ecosystem file does not use current', 'ecosystem-cwd-current', (f) => {
      writeFileSync(join(f.root, 'ecosystem.config.cjs'), "module.exports = { apps: [{ cwd: '/elsewhere' }] };\n");
      git(f.home, f.root, 'commit', '--quiet', '-am', 'eco');
    }],
    ['no legacy restart config is set', 'legacy-ecosystem-config', () => {}, { layout: { type: 'releases', sharedPaths: ['.env', 'data'] } }],
    ['the legacy restart config points at current', 'legacy-ecosystem-cwd-root', (f) => {
      writeFileSync(join(f.root, 'ecosystem.legacy.config.cjs'), `module.exports = { apps: [{ name: 'app', cwd: '${f.root}/current' }] };\n`);
      git(f.home, f.root, 'commit', '--quiet', '-am', 'legacy eco');
    }],
    ['there is no host lock configured', 'both-locks', () => {}, { hostLock: null }],
    ['the layout block is absent', 'layout-config', () => {}, { layout: null }],
  ];
  it.each(refusals)('refuses when %s, changing nothing', (_label, failing, arrange, configOver) => {
    const f = fixture(configOver || {});
    arrange(f);
    const before = snapshot(f.root);
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(exitCode).toBe(3);
    expect(result.refused).toBe('layout-precondition-failed');
    expect(preconditionFailed(result, failing)).toBe(true);
    expect(snapshot(f.root)).toEqual(before);
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
  });

  it('refuses a tracked sharedPath', () => {
    const f = fixture();
    git(f.home, f.root, 'add', '-f', '.env');
    git(f.home, f.root, 'commit', '--quiet', '-m', 'track env');
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(exitCode).toBe(3);
    expect(preconditionFailed(result, 'shared-path:.env')).toBe(true);
  });

  it('a dry run executes only read-only commands and changes nothing', () => {
    const f = fixture();
    const before = snapshot(f.root);
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases', dryRun: true }, f.deps());
    expect(exitCode).toBe(0);
    expect(result).toMatchObject({ dryRun: true, verified: false, sha: f.sha });
    expect(result.preconditions.every((p: any) => p.ok)).toBe(true);
    expect(result.steps.map((s: any) => s.name)).toEqual(FORWARD_STEPS);
    expect(result.steps.every((s: any) => s.commands.length > 0)).toBe(true);
    expect(snapshot(f.root)).toEqual(before);
    const planned = result.steps.flatMap((s: any) => s.commands);
    expect(f.commands.filter((c) => planned.some((p: string) => c.includes(p)))).toEqual([]);
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
    expect(existsSync(join(f.home, 'hosts', 'bigpi.lock'))).toBe(false);
  });

  it('a dry run still reports a failing precondition (exit 3)', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'stray.txt'), 'x');
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases', dryRun: true }, f.deps());
    expect(exitCode).toBe(3);
    expect(preconditionFailed(result, 'git-clean')).toBe(true);
  });

  it.each(FORWARD_STEPS)('a crash at layout-%s leaves the journal and a rerun refuses', (step) => {
    const f = fixture();
    expect(() => migrateLayout(f.config, { to: 'releases' }, f.deps({ env: { DEPLOY_KIT_TEST_CRASH_AT: `layout-${step}` }, crash: crashSeam }))).toThrow('crash');
    const journal = JSON.parse(readFileSync(join(f.root, 'layout-migrate.journal.json'), 'utf8'));
    expect(journal.steps.map((s: any) => s.name)).toEqual(FORWARD_STEPS.slice(0, FORWARD_STEPS.indexOf(step) + 1));
    expect(journal.steps[journal.steps.length - 1]).toMatchObject({ name: step, status: 'begun' });
    expect(existsSync(join(f.home, 'hosts', 'bigpi.lock'))).toBe(false); // the lock does not outlive the process here
    const after = snapshot(f.root);
    f.commands.length = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(exitCode).toBe(3);
    expect(result.refused).toBe('layout-migrate-interrupted');
    expect(result.message).toContain('will not resume');
    expect(result.message).toContain(`[${step}]`);
    expect(snapshot(f.root)).toEqual(after);
    // Reverse refuses too: an interrupted migration is resolved by hand, in either direction.
    expect(migrateLayout(f.config, { to: 'legacy' }, f.deps()).result.refused).toBe('layout-migrate-interrupted');
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
  });
});

describeOnPosix('layout migrate: reverse', () => {
  const treeWithoutLayout = (root: string) => snapshot(root, LAYOUT_ENTRIES);

  it('round-trips to an identical tree: HEAD, file list and shared data inodes', () => {
    const f = fixture();
    const before = treeWithoutLayout(f.root);
    const headBefore = git(f.home, f.root, 'rev-parse', 'HEAD');
    const forward = migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(forward.exitCode).toBe(0);
    f.commands.length = 0;
    f.lockSeen.length = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(result).toMatchObject({ direction: 'reverse', sha: f.sha, verified: true });
    expect(exitCode).toBe(0);
    expect(result.steps.map((s: any) => s.name)).toEqual(['stop', 'legacy', 'shared', 'unlayout', 'restart']);
    expect(git(f.home, f.root, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(treeWithoutLayout(f.root)).toEqual(before); // includes each file's inode, so the shared data was moved back
    expect(existsSync(join(f.root, '.deploy-kit-layout'))).toBe(false);
    expect(existsSync(join(f.root, 'current'))).toBe(false);
    expect(existsSync(join(f.root, '.legacy-checkout'))).toBe(false);
    expect(existsSync(join(f.root, 'layout-migrate.journal.json'))).toBe(false);
    expect(readFileSync(join(f.root, 'data', 'db.sqlite'), 'utf8')).toBe('rows');
    expect(f.lockSeen).toEqual(['both', 'both']); // stop and restart both ran under the locks
    expect(f.commands.find((c) => /pm2 startOrRestart/.test(c))).toContain(`${f.root}/ecosystem.legacy.config.cjs`);
    // The app ends up running from the legacy root, not from the removed current.
    expect(f.pm2.cwd).toBe(f.root);
    expect(f.pm2.files).toEqual([`${f.root}/ecosystem.config.cjs`, `${f.root}/ecosystem.legacy.config.cjs`]);
  });

  it('refuses a reverse whose restart config points at current BEFORE stopping anything', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    writeFileSync(join(f.root, '.legacy-checkout', 'ecosystem.legacy.config.cjs'), `module.exports = { apps: [{ name: 'app', cwd: '${f.root}/current' }] };\n`);
    const before = snapshot(f.root);
    f.commands.length = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(3);
    expect(preconditionFailed(result, 'legacy-ecosystem-cwd-root')).toBe(true);
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
    expect(snapshot(f.root)).toEqual(before);
    expect(f.pm2.cwd).toBe(`${f.root}/current`);
  });

  it('refuses a reverse when the migration record names no legacy restart config', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    const markerFile = join(f.root, '.deploy-kit-layout');
    const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
    delete marker.migration.legacyEcosystemFile;
    writeFileSync(markerFile, JSON.stringify(marker));
    f.commands.length = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(3);
    expect(preconditionFailed(result, 'legacy-ecosystem-cwd-root')).toBe(true);
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
  });

  it('fails verification when the restarted process does not run from the legacy root', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    f.pm2.forceCwd = `${f.root}/current`;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.verified).toBe(false);
    expect(result.failed).toMatch(/PM2 process app cwd is .*\/current, expected/);
  });

  it('fails verification when the process is errored with pid 0, even though pm2 records the legacy cwd', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    f.pm2.status = 'errored';
    f.pm2.pid = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.failed).toMatch(/PM2 process app is errored, expected online/);
    expect(result.failed).toMatch(/no live pid/);
  });

  it('fails verification when the live process runs from a different cwd than pm2 records', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    f.pm2.procCwd = f.home;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.failed).toMatch(/pid 4242\) is running from .*, expected/);
  });

  it.each([
    ['the process cwd read', 'readlink -f /proc/', /is running from <unknown>, expected/],
    ['both the root and the process cwd reads', 'pwd -P', /cannot resolve the legacy root/],
  ])('fails verification when %s fails: two failed reads never compare equal', (_label, failing, expected) => {
    const f = fixture();
    expect(migrateLayout(f.config, { to: 'releases' }, f.deps()).exitCode).toBe(0);
    const base = f.runtime.execFileSync;
    let restarted = false; // the probes fail only in verify, after the reverse restart (pwd -P is also a precondition)
    f.runtime.execFileSync = (file: string, args: string[], opts: any) => {
      const cmd = String(args[args.length - 1]);
      if (cmd.includes('pm2 startOrRestart')) restarted = true;
      if (restarted && (cmd.includes(failing) || (failing === 'pwd -P' && cmd.includes('readlink -f /proc/')))) {
        throw Object.assign(new Error('probe failed'), { status: 1, stdout: '', stderr: 'no such file' });
      }
      return base(file, args, opts);
    };
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.failed).toMatch(expected);
  });

  it('fails verification when one of two apps (a dead worker behind a healthy API) is not online', () => {
    const f = fixture({ appNames: ['app', 'worker'] });
    const twoApps = (cwd: string) => `module.exports = { apps: [{ name: 'app', cwd: '${cwd}' }, { name: 'worker', cwd: '${cwd}' }] };\n`;
    writeFileSync(join(f.root, 'ecosystem.config.cjs'), twoApps(`${f.root}/current`));
    writeFileSync(join(f.root, 'ecosystem.legacy.config.cjs'), twoApps(f.root));
    git(f.home, f.root, 'add', 'ecosystem.config.cjs', 'ecosystem.legacy.config.cjs');
    git(f.home, f.root, 'commit', '--quiet', '-m', 'two apps');
    git(f.home, f.root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/master');
    const base = f.runtime.execFileSync;
    let reversing = false;
    let restarted = false; // the worker is healthy until the reverse restart, then dies while the API comes up
    f.runtime.execFileSync = (file: string, args: string[], opts: any) => {
      const cmd = String(args[args.length - 1]);
      if (reversing && cmd.includes('pm2 startOrRestart')) restarted = true;
      const out = base(file, args, opts);
      if (!cmd.includes('pm2 jlist') || !f.pm2.cwd) return out;
      const worker = restarted ? { pid: 0, status: 'errored' } : { pid: 5000, status: 'online' };
      return JSON.stringify([...JSON.parse(out), { name: 'worker', pid: worker.pid, pm_cwd: f.pm2.cwd, pm2_env: { status: worker.status, pm_cwd: f.pm2.cwd } }]);
    };
    expect(migrateLayout(f.config, { to: 'releases' }, f.deps()).exitCode).toBe(0);
    reversing = true;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.failed).toMatch(/PM2 process worker is errored/);
  });

  it('fails verification when the running sha is not the forward-time sha', () => {
    const f = fixture({ layout: { type: 'releases', sharedPaths: ['.env', 'data'], legacyEcosystemFile: 'ecosystem.legacy.config.cjs', runningShaCommand: 'echo 0123456789abcdef' } });
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(2);
    expect(result.failed).toMatch(/running sha is 0123456789abcdef/);
  });

  it('passes the running-sha check when the app reports the forward-time sha', () => {
    const f = fixture({ layout: { type: 'releases', sharedPaths: ['.env', 'data'], legacyEcosystemFile: 'ecosystem.legacy.config.cjs', runningShaCommand: 'git rev-parse HEAD' } });
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(migrateLayout(f.config, { to: 'legacy' }, f.deps()).exitCode).toBe(0);
  });

  it('keeps data written after the forward migration (it never restores an old snapshot)', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    writeFileSync(join(f.root, 'current', 'data', 'db.sqlite'), 'rows-after-cutover');
    writeFileSync(join(f.root, 'current', '.env'), 'SECRET=2\n');
    expect(migrateLayout(f.config, { to: 'legacy' }, f.deps()).exitCode).toBe(0);
    expect(readFileSync(join(f.root, 'data', 'db.sqlite'), 'utf8')).toBe('rows-after-cutover');
    expect(readFileSync(join(f.root, '.env'), 'utf8')).toBe('SECRET=2\n');
  });

  function deployAfterForward(f: Fixture, newCommit: boolean) {
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    const repoGit = join(f.root, 'repo.git');
    let sha = f.sha;
    if (newCommit) {
      git(f.home, join(f.root, 'current'), 'commit', '--quiet', '--allow-empty', '-m', 'deployed');
      sha = git(f.home, join(f.root, 'current'), 'rev-parse', 'HEAD');
    }
    const id = `${sha.slice(0, 12)}-20990101T000000Z`;
    git(f.home, f.root, `--git-dir=${repoGit}`, 'worktree', 'add', '--detach', join(f.root, 'releases', id), sha);
    const old = readlinkSync(join(f.root, 'current'));
    rmSync(join(f.root, 'current'));
    symlinkSync(`releases/${id}`, join(f.root, 'current'));
    symlinkSync(old, join(f.root, 'previous'));
  }

  it.each([['a new sha', true], ['the same sha, a new release', false]])('refuses layout-reverse-after-deploy after %s', (_l, newCommit) => {
    const f = fixture();
    deployAfterForward(f, newCommit as boolean);
    const before = snapshot(f.root);
    f.commands.length = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(3);
    expect(result.refused).toBe('layout-reverse-after-deploy');
    expect(snapshot(f.root)).toEqual(before);
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
  });

  it('refuses when the marker has no migration record (a hand-migrated host)', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    writeFileSync(join(f.root, '.deploy-kit-layout'), '{"layout":"releases","version":1}\n');
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(3);
    expect(preconditionFailed(result, 'marker-records-migration')).toBe(true);
  });

  it('refuses on a legacy host (no marker)', () => {
    const f = fixture();
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(3);
    expect(preconditionFailed(result, 'marker-records-migration')).toBe(true);
  });

  it('refuses when the stable ecosystem file was edited since forward', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    writeFileSync(join(f.root, 'ecosystem.config.cjs'), 'edited');
    const { result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(preconditionFailed(result, 'stable-ecosystem-unmodified')).toBe(true);
  });

  it('a reverse dry run changes nothing', () => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    const before = snapshot(f.root);
    f.commands.length = 0;
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy', dryRun: true }, f.deps());
    expect(exitCode).toBe(0);
    expect(result.dryRun).toBe(true);
    expect(result.preconditions.every((p: any) => p.ok)).toBe(true);
    expect(snapshot(f.root)).toEqual(before);
    expect(f.commands.some((c) => /pm2 /.test(c))).toBe(false);
  });

  it.each(['stop', 'legacy', 'shared', 'unlayout', 'restart'])('a crash at layout-%s leaves the journal and a rerun refuses', (step) => {
    const f = fixture();
    migrateLayout(f.config, { to: 'releases' }, f.deps());
    expect(() => migrateLayout(f.config, { to: 'legacy' }, f.deps({ env: { DEPLOY_KIT_TEST_CRASH_AT: `layout-${step}` }, crash: crashSeam }))).toThrow('crash');
    expect(existsSync(join(f.root, 'layout-migrate.journal.json'))).toBe(true);
    const { exitCode, result } = migrateLayout(f.config, { to: 'legacy' }, f.deps());
    expect(exitCode).toBe(3);
    expect(result.refused).toBe('layout-migrate-interrupted');
  });
});

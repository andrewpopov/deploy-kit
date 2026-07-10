import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const {
  buildTargetCommand, sshHardeningArgs, loadConfig, mergeConfig, validateConfig,
  DEFAULT_CONFIG, deploy, rollback, remote, buildHealthCommand, startTunnel, init, runOnTarget,
} = kit;
const cli = require('../cli.js') as { run: Function; parseOptions: Function };

// A fake execFileSync that records every command and returns programmed output.
// The command to run is always the LAST arg: local is ('sh', ['-c', cmd]); ssh is
// ('ssh', [...hardening -o flags, host, 'cd dir && <cmd>']).
function makeRuntime({ fail = [] as string[] } = {}) {
  const calls: string[] = [];
  const execFileSync = (file: string, args: string[]) => {
    const remoteCmd = args[args.length - 1];
    calls.push(remoteCmd);
    if (fail.some((f) => remoteCmd.includes(f))) {
      const err: any = new Error(`fake failure: ${remoteCmd}`);
      err.stdout = '';
      throw err;
    }
    if (remoteCmd.includes('curl')) return '200';
    return '';
  };
  return { runtime: { execFileSync }, calls };
}

const baseConfig = mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  dbBoundApps: ['app'],
  branch: 'master',
  hooks: { install: 'npm ci', backup: 'npm run db:backup', migrate: 'npm run db:migrate', build: 'npm run build' },
});

const ctxWith = (runtime: any) => ({ runtime, sleep: () => {} });

describe('config', () => {
  it('deep-merges hooks and health over defaults', () => {
    const c = mergeConfig(DEFAULT_CONFIG, { hooks: { migrate: 'x' }, health: { attempts: 5 } });
    expect(c.hooks.install).toBe(DEFAULT_CONFIG.hooks.install); // preserved
    expect(c.hooks.migrate).toBe('x');
    expect(c.health.attempts).toBe(5);
    expect(c.health.delaySeconds).toBe(DEFAULT_CONFIG.health.delaySeconds);
  });

  it('loadConfig returns defaults when no config file exists', () => {
    const fsImpl = { existsSync: () => false, readFileSync: () => '' };
    const c = loadConfig({ cwd: '/nowhere', fsImpl });
    expect(c.mode).toBe('ssh');
    expect(c.appNames).toEqual([]);
  });
});

describe('buildTargetCommand', () => {
  it('wraps ssh with cd into projectDir', () => {
    const { file, args } = buildTargetCommand('pm2 status', { mode: 'ssh', host: 'app@pi', projectDir: '/srv/app' });
    expect(file).toBe('ssh');
    expect(args).toEqual(['app@pi', 'cd /srv/app && pm2 status']);
  });
  it('runs local mode via sh -c', () => {
    const { file, args } = buildTargetCommand('pm2 status', { mode: 'local', host: null, projectDir: '/srv/app' });
    expect(file).toBe('sh');
    expect(args).toEqual(['-c', 'cd /srv/app && pm2 status']);
  });
  it('throws in ssh mode without a host', () => {
    expect(() => buildTargetCommand('x', { mode: 'ssh', host: null, projectDir: '/d' })).toThrow(/requires a .host/);
  });
});

describe('deploy pipeline', () => {
  it('runs steps in the correct order with the safety gates', () => {
    const { runtime, calls } = makeRuntime();
    const result = deploy(baseConfig, {}, ctxWith(runtime));
    expect(result.steps).toEqual(['stash', 'pull:master', 'install', 'backup', 'migrate', 'build', 'restart', 'health']);
    const joined = calls.join('\n');
    // backup happens before migrate; db-bound app is stopped before migrate.
    expect(joined.indexOf('db:backup')).toBeLessThan(joined.indexOf('pm2 stop app'));
    expect(joined.indexOf('pm2 stop app')).toBeLessThan(joined.indexOf('db:migrate'));
    expect(joined.indexOf('db:migrate')).toBeLessThan(joined.indexOf('npm run build'));
    expect(joined).toContain('git pull --ff-only origin master');
    expect(joined).toContain("http://localhost:3000/api/health");
  });

  it('aborts BEFORE migrating if the backup gate fails', () => {
    const { runtime, calls } = makeRuntime({ fail: ['db:backup'] });
    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow(/Pre-migration database backup failed/);
    expect(calls.join('\n')).not.toContain('db:migrate');
  });

  it('resumes paused db-bound apps if the migration fails, then aborts', () => {
    const { runtime, calls } = makeRuntime({ fail: ['db:migrate'] });
    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow(/Running database migrations failed/);
    // the paused app must be brought back up (pm2 start) before aborting
    expect(calls.some((c) => c.includes('pm2 start app'))).toBe(true);
  });

  it('resumes paused db-bound apps if the BUILD fails (never leaves prod stopped)', () => {
    const { runtime, calls } = makeRuntime({ fail: ['npm run build'] });
    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow(/Building failed/);
    // build runs after migrate with apps paused — a build failure must resume them
    expect(calls.some((c) => c.includes('pm2 start app'))).toBe(true);
    // and it must not have reached the final restart/health
    expect(calls.some((c) => c.includes('curl'))).toBe(false);
  });

  it('throws if health never comes up', () => {
    const runtime = {
      execFileSync: (_file: string, args: string[]) => (args[args.length - 1].includes('curl') ? '503' : ''),
    };
    const cfg = mergeConfig(baseConfig, { health: { attempts: 2, delaySeconds: 0 } });
    expect(() => deploy(cfg, {}, { runtime, sleep: () => {} })).toThrow(/unhealthy/);
  });

  it('buildBeforeMigrate builds while apps are up, before stop+migrate', () => {
    const { runtime, calls } = makeRuntime();
    const result = deploy(mergeConfig(baseConfig, { buildBeforeMigrate: true }), {}, ctxWith(runtime));
    // build now precedes backup/stop/migrate (only one build)
    expect(result.steps).toEqual(['stash', 'pull:master', 'install', 'build', 'backup', 'migrate', 'restart', 'health']);
    const joined = calls.join('\n');
    expect(joined.indexOf('npm run build')).toBeLessThan(joined.indexOf('db:backup'));
    expect(joined.indexOf('npm run build')).toBeLessThan(joined.indexOf('pm2 stop app'));
  });

  it('a buildBeforeMigrate build failure aborts before anything is stopped', () => {
    const { runtime, calls } = makeRuntime({ fail: ['npm run build'] });
    expect(() => deploy(mergeConfig(baseConfig, { buildBeforeMigrate: true }), {}, ctxWith(runtime)))
      .toThrow(/Building failed/);
    expect(calls.some((c) => c.includes('pm2 stop app'))).toBe(false);
    expect(calls.some((c) => c.includes('db:backup'))).toBe(false);
  });

  it('ecosystemFile restarts apps via start-or-restart from the file (first-deploy safe)', () => {
    const { runtime, calls } = makeRuntime();
    deploy(mergeConfig(baseConfig, { ecosystemFile: 'ecosystem.config.cjs' }), {}, ctxWith(runtime));
    expect(calls.some((c) => c.includes('pm2 start ecosystem.config.cjs --only app 2>/dev/null || pm2 restart app'))).toBe(true);
  });

  it('without ecosystemFile the app restart stays plain pm2 restart', () => {
    const { runtime, calls } = makeRuntime();
    deploy(baseConfig, {}, ctxWith(runtime));
    expect(calls.some((c) => c.includes('pm2 restart app'))).toBe(true);
    expect(calls.some((c) => c.includes('--only'))).toBe(false);
  });

  const ensureConfig = mergeConfig(baseConfig, {
    ensureApps: ['app-tunnel'],
    ecosystemFile: 'ecosystem.config.cjs',
  });

  it('ensureApps brings auxiliary processes up (tolerant) after the app restart', () => {
    const { runtime, calls } = makeRuntime();
    const result = deploy(ensureConfig, {}, ctxWith(runtime));
    expect(result.steps).toEqual(
      ['stash', 'pull:master', 'install', 'backup', 'migrate', 'build', 'restart', 'ensure', 'health'],
    );
    const joined = calls.join('\n');
    expect(joined).toContain('pm2 start ecosystem.config.cjs --only app-tunnel 2>/dev/null || pm2 restart app-tunnel');
    // ensured apps come up after the main app, before the health gate
    expect(joined.indexOf('--only app ')).toBeLessThan(joined.indexOf('--only app-tunnel'));
    expect(joined.indexOf('--only app-tunnel')).toBeLessThan(joined.indexOf('curl'));
  });

  it('an ensureApps failure does not abort an otherwise healthy deploy', () => {
    const { runtime } = makeRuntime({ fail: ['app-tunnel'] });
    const result = deploy(ensureConfig, {}, ctxWith(runtime));
    expect(result.healthy).toBe(true);
    expect(result.steps).toContain('ensure');
    expect(result.steps).toContain('health');
  });

  it('no ensure step when ensureApps is empty', () => {
    const { runtime } = makeRuntime();
    const result = deploy(mergeConfig(baseConfig, { tunnelName: 'app-tunnel' }), {}, ctxWith(runtime));
    expect(result.steps).not.toContain('ensure');
  });

  it('ensures multiple auxiliary processes in order', () => {
    const { runtime, calls } = makeRuntime();
    deploy(mergeConfig(baseConfig, { ensureApps: ['aux1', 'aux2'] }), {}, ctxWith(runtime));
    const joined = calls.join('\n');
    expect(joined).toContain('pm2 restart aux1');
    expect(joined).toContain('pm2 restart aux2');
    expect(joined.indexOf('pm2 restart aux1')).toBeLessThan(joined.indexOf('pm2 restart aux2'));
  });

  const checkConfig = mergeConfig(baseConfig, {
    preDeployChecks: [{ name: 'disk', command: 'test -d /srv' }],
  });

  it('preDeployChecks run first and gate the deploy', () => {
    const { runtime, calls } = makeRuntime();
    const result = deploy(checkConfig, {}, ctxWith(runtime));
    expect(result.steps[0]).toBe('check:disk');
    const joined = calls.join('\n');
    // the check runs before any mutation (stash/fetch/pull)
    expect(joined.indexOf('test -d /srv')).toBeLessThan(joined.indexOf('git fetch'));
    expect(joined.indexOf('test -d /srv')).toBeLessThan(joined.indexOf('git stash'));
  });

  it('a failing preDeployCheck aborts before touching anything', () => {
    const { runtime, calls } = makeRuntime({ fail: ['test -d /srv'] });
    expect(() => deploy(checkConfig, {}, ctxWith(runtime))).toThrow(/Pre-deploy check: disk failed/);
    const joined = calls.join('\n');
    expect(joined).not.toContain('git fetch');
    expect(joined).not.toContain('git stash');
    expect(joined).not.toContain('npm ci');
  });

  it('skips deps/build/migrate when requested', () => {
    const { runtime } = makeRuntime();
    const result = deploy(baseConfig, { skipDeps: true, skipBuild: true, skipMigrate: true, stash: false }, ctxWith(runtime));
    expect(result.steps).toEqual(['pull:master', 'restart', 'health']);
  });
});

describe('buildHealthCommand', () => {
  const { buildHealthCommand } = kit;
  it('builds a plain probe with no headers', () => {
    const cmd = buildHealthCommand(mergeConfig(baseConfig, { port: 3001, healthPath: '/api/health' }));
    expect(cmd).toBe("curl -f -s 'http://localhost:3001/api/health' -o /dev/null -w '%{http_code}'");
  });
  it('injects healthHeaders (e.g. X-Forwarded-Proto for a proxy-redirecting app)', () => {
    const cmd = buildHealthCommand(mergeConfig(baseConfig, {
      port: 3001, healthPath: '/api/health', healthHeaders: { 'X-Forwarded-Proto': 'https' },
    }));
    expect(cmd).toContain("-H 'X-Forwarded-Proto: https'");
    expect(cmd).toContain('http://localhost:3001/api/health');
  });
});

describe('remote ops', () => {
  it('restart issues pm2 restart for configured apps', () => {
    const { runtime, calls } = makeRuntime();
    const ok = remote.restart(baseConfig, { runtime });
    expect(ok).toBe(true);
    expect(calls.some((c) => c.includes('pm2 restart app'))).toBe(true);
  });
  it('health returns true on 200', () => {
    const { runtime } = makeRuntime();
    expect(remote.health(baseConfig, { runtime })).toBe(true);
  });

  it('status runs pm2 status', () => {
    const { runtime, calls } = makeRuntime();
    expect(remote.status(baseConfig, { runtime })).toBe(true);
    expect(calls.some((c) => c.includes('pm2 status'))).toBe(true);
  });

  it('logs composes --err/--lines/--follow flags and targets appNames', () => {
    const { runtime, calls } = makeRuntime();
    remote.logs(baseConfig, { lines: 100, errors: true }, { runtime });
    expect(calls.some((c) => c.includes('pm2 logs app --err --lines 100 --nostream'))).toBe(true);
    const follow = makeRuntime();
    remote.logs(baseConfig, { follow: true }, { runtime: follow.runtime });
    expect(follow.calls.some((c) => c.includes('pm2 logs app --raw'))).toBe(true);
  });

  it('logs falls back to `all` when no appNames', () => {
    const { runtime, calls } = makeRuntime();
    remote.logs(mergeConfig(DEFAULT_CONFIG, { host: 'a@b', projectDir: '/d' }), {}, { runtime });
    expect(calls.some((c) => c.includes('pm2 logs all'))).toBe(true);
  });

  it('lifecycle errors (returns false) with no appNames configured', () => {
    const errs: string[] = [];
    const log = { ...kit.makeLogger(), error: (m: string) => errs.push(m) };
    const cfg = mergeConfig(DEFAULT_CONFIG, { host: 'a@b', projectDir: '/d' });
    const { runtime, calls } = makeRuntime();
    expect(remote.restart(cfg, { runtime, log })).toBe(false);
    expect(errs.join()).toMatch(/No appNames/);
    expect(calls.some((c) => c.includes('pm2 restart'))).toBe(false);
  });

  it('start/stop persist the process list after success', () => {
    const { runtime, calls } = makeRuntime();
    remote.stop(baseConfig, { runtime });
    expect(calls.some((c) => c.includes('pm2 stop app'))).toBe(true);
    expect(calls.some((c) => c.includes('pm2 save'))).toBe(true);
  });

  it('allApps dedups appNames + ensureApps + tunnelName, dropping falsy', () => {
    const cfg = mergeConfig(baseConfig, { appNames: ['a', 'b'], ensureApps: ['b', 't'], tunnelName: 't' });
    expect(remote.allApps(cfg).sort()).toEqual(['a', 'b', 't']);
  });

  it('dashboard/resources/gitInfo run and return true', () => {
    const { runtime, calls } = makeRuntime();
    expect(remote.resources(baseConfig, { runtime })).toBe(true);
    expect(remote.gitInfo(baseConfig, { runtime })).toBe(true);
    expect(remote.dashboard(baseConfig, { runtime })).toBe(true);
    expect(calls.some((c) => c.includes('free -h'))).toBe(true);
    expect(calls.some((c) => c.includes('git log -1'))).toBe(true);
  });
});

describe('ssh hardening', () => {
  it('sshHardeningArgs builds ConnectTimeout/ServerAlive flags from defaults', () => {
    expect(sshHardeningArgs(DEFAULT_CONFIG.ssh)).toEqual([
      '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ]);
  });
  it('omits a flag when its config value is null and appends raw options', () => {
    expect(sshHardeningArgs({ connectTimeout: null, serverAliveInterval: 5, serverAliveCountMax: null, options: ['BatchMode=yes'] }))
      .toEqual(['-o', 'ServerAliveInterval=5', '-o', 'BatchMode=yes']);
  });
  it('buildTargetCommand prepends hardening args before host in ssh mode', () => {
    const { file, args } = buildTargetCommand('pm2 status', {
      mode: 'ssh', host: 'app@pi', projectDir: '/srv/app', ssh: DEFAULT_CONFIG.ssh,
    } as any);
    expect(file).toBe('ssh');
    expect(args[args.length - 2]).toBe('app@pi');
    expect(args[args.length - 1]).toBe('cd /srv/app && pm2 status');
    expect(args.slice(0, 6)).toEqual(['-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3']);
  });
  it('local mode never gets ssh flags', () => {
    const { args } = buildTargetCommand('pm2 status', { mode: 'local', host: null, projectDir: '/d', ssh: DEFAULT_CONFIG.ssh } as any);
    expect(args).toEqual(['-c', 'cd /d && pm2 status']);
  });
});

describe('stepTimeoutSeconds', () => {
  it('passes a timeout (ms) to execFileSync when set', () => {
    let seenTimeout: number | undefined;
    const runtime = {
      execFileSync: (_f: string, a: string[], opts: any) => { seenTimeout = opts?.timeout; return a[a.length - 1].includes('curl') ? '200' : ''; },
    };
    deploy(mergeConfig(baseConfig, { stepTimeoutSeconds: 30 }), { stash: false }, { runtime, sleep: () => {} });
    expect(seenTimeout).toBe(30000);
  });
  it('bounds every step by default (standard 3: a timeout that defaults to off is not a bound)', () => {
    // deploy.js holds an atomic lock for the whole run, so a step that never
    // returns blocks every subsequent deploy until someone runs --steal-lock.
    let seenTimeout: any = 'unset';
    let seenKill: any = 'unset';
    const runtime = {
      execFileSync: (_f: string, a: string[], opts: any) => {
        seenTimeout = opts?.timeout;
        seenKill = opts?.killSignal;
        return a[a.length - 1].includes('curl') ? '200' : '';
      },
    };
    deploy(baseConfig, { stash: false }, { runtime, sleep: () => {} });
    expect(seenTimeout).toBe(1800 * 1000);
    expect(seenKill).toBe('SIGKILL');
  });

  it('an explicit stepTimeoutSeconds: null opts out of the bound', () => {
    let seenTimeout: any = 'unset';
    const runtime = {
      execFileSync: (_f: string, a: string[], opts: any) => { seenTimeout = opts?.timeout; return a[a.length - 1].includes('curl') ? '200' : ''; },
    };
    deploy({ ...baseConfig, stepTimeoutSeconds: null }, { stash: false }, { runtime, sleep: () => {} });
    expect(seenTimeout).toBeUndefined();
  });

  it('a consumer can tighten the bound', () => {
    let seenTimeout: any = 'unset';
    const runtime = {
      execFileSync: (_f: string, a: string[], opts: any) => { seenTimeout = opts?.timeout; return a[a.length - 1].includes('curl') ? '200' : ''; },
    };
    deploy({ ...baseConfig, stepTimeoutSeconds: 60 }, { stash: false }, { runtime, sleep: () => {} });
    expect(seenTimeout).toBe(60_000);
  });

  it('a timed-out step names the bound and the command instead of a raw errno', () => {
    const timedOut: any = Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const runtime = {
      execFileSync: () => { throw timedOut; },
    };
    const result = runOnTarget('npm ci', { ...baseConfig, stepTimeoutSeconds: 900 }, { runtime });
    expect(result.ok).toBe(false);
    expect(result.error.message).toMatch(/exceeded the 900s timeout bound/);
    expect(result.error.message).toMatch(/npm ci/);
  });
});

describe('config validation', () => {
  it('flags unknown keys', () => {
    const p = validateConfig({ host: 'a@b', notAKey: 1 });
    expect(p.join()).toMatch(/unknown key "notAKey"/);
  });
  it('flags a removed key with a migration hint', () => {
    const p = validateConfig({ ensureTunnelOnDeploy: true });
    expect(p.join()).toMatch(/ensureTunnelOnDeploy.*ensureApps/);
  });
  it('flags wrong types and a bad mode', () => {
    expect(validateConfig({ port: 'nope' }).join()).toMatch(/"port" must be number/);
    expect(validateConfig({ appNames: 'app' }).join()).toMatch(/"appNames" must be array/);
    expect(validateConfig({ mode: 'telnet' }).join()).toMatch(/"mode" must be "ssh" or "local"/);
  });
  it('rejects a non-absolute or metacharacter-laden projectDir', () => {
    expect(validateConfig({ projectDir: 'relative/path' }).join()).toMatch(/absolute path/);
    expect(validateConfig({ projectDir: '/srv/my app' }).join()).toMatch(/spaces or shell metacharacters/);
    expect(validateConfig({ projectDir: '/srv/app;rm -rf /' }).join()).toMatch(/shell metacharacters/);
    expect(validateConfig({ projectDir: '/srv/app-1_2.3' })).toEqual([]);
  });
  it('accepts a valid config with no problems', () => {
    expect(validateConfig({ host: 'a@b', port: 3000, appNames: ['x'], hooks: {} })).toEqual([]);
  });
  it('loadConfig throws on an invalid config file', () => {
    const fsImpl = { existsSync: () => true, readFileSync: () => JSON.stringify({ ensureTunnelOnDeploy: true }) };
    expect(() => loadConfig({ cwd: '/x', fsImpl })).toThrow(/ensureTunnelOnDeploy/);
  });
  it('loadConfig warns instead of throwing when strict:false', () => {
    const warnings: string[] = [];
    const log = { ...kit.makeLogger(), warning: (m: string) => warnings.push(m) };
    const fsImpl = { existsSync: () => true, readFileSync: () => JSON.stringify({ bogus: 1 }) };
    const c = loadConfig({ cwd: '/x', fsImpl, strict: false, log });
    expect(c.mode).toBe('ssh');
    expect(warnings.join()).toMatch(/unknown key "bogus"/);
  });
  it('loadConfig throws a clear error on malformed JSON', () => {
    const fsImpl = { existsSync: () => true, readFileSync: () => '{ not json' };
    expect(() => loadConfig({ cwd: '/x', fsImpl })).toThrow(/Failed to parse/);
  });
  it('install hook default prefers the offline cache first', () => {
    expect(DEFAULT_CONFIG.hooks.install).toBe('npm ci --prefer-offline || npm ci || npm install');
  });
});

describe('deploy: lock, sha, stash-drop', () => {
  it('records the pre-pull SHA before fetching', () => {
    const { runtime, calls } = makeRuntime();
    deploy(baseConfig, {}, ctxWith(runtime));
    const joined = calls.join('\n');
    expect(joined).toContain('git rev-parse HEAD > /tmp/deploy-kit-');
    expect(joined.indexOf('git rev-parse HEAD > /tmp/deploy-kit-')).toBeLessThan(joined.indexOf('git fetch'));
  });
  it('drops the deploy-kit stash after a successful pull', () => {
    const { runtime, calls } = makeRuntime();
    deploy(baseConfig, {}, ctxWith(runtime));
    expect(calls.some((c) => c.includes('git stash drop'))).toBe(true);
  });
  it('takes a lock (mkdir) and releases it (rmdir)', () => {
    const { runtime, calls } = makeRuntime();
    deploy(baseConfig, {}, ctxWith(runtime));
    expect(calls.some((c) => /mkdir \/tmp\/deploy-kit-.*\.lock/.test(c))).toBe(true);
    expect(calls.some((c) => /rmdir \/tmp\/deploy-kit-.*\.lock/.test(c))).toBe(true);
  });
  it('aborts when the lock is already held', () => {
    const { runtime } = makeRuntime({ fail: ['mkdir'] });
    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow(/Another deploy holds the lock/);
  });
  it('--steal-lock forces past a held lock', () => {
    const { runtime, calls } = makeRuntime({ fail: ['mkdir'] });
    const result = deploy(baseConfig, { stealLock: true }, ctxWith(runtime));
    expect(result.healthy).toBe(true);
    expect(calls.some((c) => c.includes('mkdir -p'))).toBe(true);
  });
  it('lock:false skips locking entirely', () => {
    const { runtime, calls } = makeRuntime();
    deploy(mergeConfig(baseConfig, { lock: false }), {}, ctxWith(runtime));
    expect(calls.some((c) => c.includes('mkdir'))).toBe(false);
  });
  it('releases the lock even when the deploy aborts', () => {
    const { runtime, calls } = makeRuntime({ fail: ['db:migrate'] });
    expect(() => deploy(baseConfig, {}, ctxWith(runtime))).toThrow();
    expect(calls.some((c) => /rmdir \/tmp\/deploy-kit-.*\.lock/.test(c))).toBe(true);
  });
});

describe('multi-endpoint health', () => {
  it('gates every healthChecks endpoint plus the scalar one', () => {
    const cfg = mergeConfig(baseConfig, { healthChecks: [{ port: 4000, path: '/worker/health' }] });
    const { runtime, calls } = makeRuntime();
    const result = deploy(cfg, {}, ctxWith(runtime));
    expect(result.healthy).toBe(true);
    const joined = calls.join('\n');
    expect(joined).toContain('http://localhost:3000/api/health');
    expect(joined).toContain('http://localhost:4000/worker/health');
  });
  it('fails the deploy if a secondary endpoint never comes up', () => {
    const cfg = mergeConfig(baseConfig, { health: { attempts: 1, delaySeconds: 0 }, healthChecks: [{ port: 4000, path: '/bad' }] });
    const runtime = {
      execFileSync: (_f: string, a: string[]) => {
        const cmd = a[a.length - 1];
        if (cmd.includes('/bad')) return '503';
        if (cmd.includes('curl')) return '200';
        return '';
      },
    };
    expect(() => deploy(cfg, {}, { runtime, sleep: () => {} })).toThrow(/unhealthy/);
  });
});

describe('waitForHealth retries', () => {
  it('recovers after N non-200s then a 200', () => {
    let n = 0;
    const runtime = {
      execFileSync: (_f: string, a: string[]) => {
        const cmd = a[a.length - 1];
        if (!cmd.includes('curl')) return '';
        n += 1;
        return n >= 3 ? '200' : '503';
      },
    };
    const cfg = mergeConfig(baseConfig, { health: { attempts: 5, delaySeconds: 0 } });
    const result = deploy(cfg, { stash: false }, { runtime, sleep: () => {} });
    expect(result.healthy).toBe(true);
    expect(n).toBe(3);
  });
});

describe('buildHealthCommand safety + overrides', () => {
  it('rejects a single quote in a header value or key', () => {
    expect(() => buildHealthCommand(mergeConfig(baseConfig, { healthHeaders: { X: "a'b" } })))
      .toThrow(/must not contain a single quote/);
    expect(() => buildHealthCommand(mergeConfig(baseConfig, { healthHeaders: { "a'b": 'x' } })))
      .toThrow(/must not contain a single quote/);
  });
  it('single-quotes the probe URL so a metacharacter path stays one command', () => {
    const cmd = buildHealthCommand(mergeConfig(baseConfig, { healthPath: '/h?a=1&b=2' }));
    expect(cmd).toContain("'http://localhost:3000/h?a=1&b=2'");
  });
  it('applies a per-check override over the scalar config', () => {
    const cmd = buildHealthCommand(baseConfig, { port: 9, path: '/z', headers: { A: 'b' } });
    expect(cmd).toContain('http://localhost:9/z');
    expect(cmd).toContain("-H 'A: b'");
  });
});

describe('local mode deploy end-to-end', () => {
  const localCfg = mergeConfig(DEFAULT_CONFIG, {
    mode: 'local', projectDir: '/srv/app', branch: 'main', appNames: ['app'], dbBoundApps: ['app'],
    hooks: { install: 'pnpm i', migrate: 'pnpm db:migrate', build: 'pnpm build' },
  });
  it('skips the stash and wraps commands in sh -c', () => {
    const localCalls: Array<[string, string[]]> = [];
    const runtime = {
      execFileSync: (file: string, a: string[]) => { localCalls.push([file, a]); return a[a.length - 1].includes('curl') ? '200' : ''; },
    };
    const result = deploy(localCfg, {}, { runtime, sleep: () => {} });
    expect(result.steps).not.toContain('stash');
    expect(localCalls.every(([file]) => file === 'sh')).toBe(true);
    expect(localCalls.every(([, a]) => a[0] === '-c')).toBe(true);
  });
});

describe('rollback', () => {
  const rbCfg = mergeConfig(baseConfig, { hooks: { ...baseConfig.hooks, install: 'npm ci' } });
  it('reads the recorded SHA, resets, rebuilds, restarts, and health-gates', () => {
    const sha = 'a'.repeat(40);
    const runtime = {
      execFileSync: (_f: string, a: string[]) => {
        const cmd = a[a.length - 1];
        if (cmd.includes('prev-sha')) return sha;
        return cmd.includes('curl') ? '200' : '';
      },
    };
    const result = rollback(rbCfg, {}, { runtime, sleep: () => {} });
    expect(result.sha).toBe(sha);
    expect(result.healthy).toBe(true);
  });
  it('throws when there is no recorded SHA', () => {
    const runtime = { execFileSync: (_f: string, a: string[]) => (a[a.length - 1].includes('curl') ? '200' : '') };
    expect(() => rollback(rbCfg, {}, { runtime, sleep: () => {} })).toThrow(/No recorded previous revision/);
  });
  it('actually issues git reset --hard <sha>', () => {
    const sha = 'b'.repeat(40);
    const seen: string[] = [];
    const runtime = {
      execFileSync: (_f: string, a: string[]) => {
        const cmd = a[a.length - 1];
        seen.push(cmd);
        if (cmd.includes('prev-sha')) return sha;
        return cmd.includes('curl') ? '200' : '';
      },
    };
    rollback(rbCfg, {}, { runtime, sleep: () => {} });
    expect(seen.some((c) => c.includes(`git reset --hard ${sha}`))).toBe(true);
  });
});

describe('init scaffold', () => {
  it('writes a skeleton config when none exists', () => {
    let written: { path: string; body: string } | null = null;
    const fsImpl = { existsSync: () => false, writeFileSync: (p: string, body: string) => { written = { path: p, body }; } };
    const quietLog = { ...kit.makeLogger(), info: () => {}, success: () => {}, warning: () => {} };
    const res = init({ cwd: '/proj', fsImpl, log: quietLog });
    expect(res.wrote).toBe(true);
    expect(written!.path).toMatch(/\.deploy-kit\.config\.json$/);
    expect(JSON.parse(written!.body).mode).toBe('ssh');
  });
  it('leaves an existing config untouched', () => {
    let wrote = false;
    const fsImpl = { existsSync: () => true, writeFileSync: () => { wrote = true; } };
    const quietLog = { ...kit.makeLogger(), info: () => {}, success: () => {}, warning: () => {} };
    const res = init({ cwd: '/proj', fsImpl, log: quietLog });
    expect(res.wrote).toBe(false);
    expect(wrote).toBe(false);
  });
});

describe('tunnel', () => {
  it('composes the cloudflared argv', () => {
    const calls: Array<[string, string[]]> = [];
    const res = startTunnel(
      { configPath: '/etc/cf.yml', tunnelName: 'app-tunnel' },
      { execFileSync: (f: string, a: string[]) => { calls.push([f, a]); return ''; }, fs: { existsSync: () => true }, log: kit.makeLogger(() => {}, () => {}) },
    );
    expect(res.args).toEqual(['tunnel', '--config', '/etc/cf.yml', 'run', 'app-tunnel']);
    expect(calls[0][0]).toBe('cloudflared');
  });
  it('throws without configPath / tunnelName / when the file is missing', () => {
    const log = kit.makeLogger(() => {}, () => {});
    expect(() => startTunnel({ tunnelName: 't' } as any, { log })).toThrow(/configPath.*required/);
    expect(() => startTunnel({ configPath: '/x' } as any, { log })).toThrow(/tunnelName.*required/);
    expect(() => startTunnel({ configPath: '/x', tunnelName: 't' }, { fs: { existsSync: () => false }, log }))
      .toThrow(/Tunnel config not found/);
  });
});

describe('cli', () => {
  it('parseOptions parses flags and --lines arity, and REJECTS the removed --force', () => {
    const o = cli.parseOptions(['--lines', '99', '--follow', '--errors', '--skip-build', '--dry-run', '--steal-lock', '--no-lock', '--no-stash']);
    expect(o).toMatchObject({ lines: 99, follow: true, errors: true, skipBuild: true, dryRun: true, stealLock: true, lock: false, stash: false });
    // `--force` was removed. Silently ignoring it let a caller believe it still
    // did something; it now throws, exactly as a removed CONFIG key does (BWK-136).
    expect(() => cli.parseOptions(['--force'])).toThrow(/Unknown argument: --force/);
  });
  it('help returns 0 for empty/help/-h', () => {
    expect(cli.run([], { cwd: '/x' })).toBe(0);
    expect(cli.run(['help'], { cwd: '/x' })).toBe(0);
    expect(cli.run(['-h'], { cwd: '/x' })).toBe(0);
  });
  it('unknown command returns 1', () => {
    expect(cli.run(['frobnicate'], { cwd: process.cwd() })).toBe(1);
  });
  it('init returns 0 (idempotent — leaves an existing config)', () => {
    const os = require('os');
    const fsMod = require('fs');
    const pathMod = require('path');
    const dir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'dk-init-'));
    fsMod.writeFileSync(pathMod.join(dir, '.deploy-kit.config.json'), '{"host":"a@b"}');
    try {
      expect(cli.run(['init'], { cwd: dir })).toBe(0);
    } finally {
      fsMod.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cli argument safety (BWK-136)', () => {
  it('rejects an unknown flag instead of silently ignoring it', () => {
    // Silently ignoring an unknown flag is dangerous exactly for the flag an
    // operator reaches for when being careful. A typo'd --dry-rn would otherwise
    // run a full production deploy while they believe nothing will happen.
    expect(() => cli.parseOptions(['--dry-rn'])).toThrow(/Unknown argument: --dry-rn/);
    expect(() => cli.parseOptions(['--totally-bogus'])).toThrow(/Unknown argument/);
    // The error names the valid options.
    expect(() => cli.parseOptions(['--nope'])).toThrow(/--dry-run/);
  });

  it('still accepts every documented flag', () => {
    expect(cli.parseOptions(['--dry-run'])).toMatchObject({ dryRun: true });
    expect(cli.parseOptions(['--skip-build', '--skip-deps', '--skip-migrate'])).toMatchObject({
      skipBuild: true, skipDeps: true, skipMigrate: true,
    });
    expect(cli.parseOptions(['--no-stash'])).toMatchObject({ stash: false });
    expect(cli.parseOptions(['--no-lock'])).toMatchObject({ lock: false });
    expect(cli.parseOptions(['--steal-lock'])).toMatchObject({ stealLock: true });
    expect(cli.parseOptions(['--lines', '20'])).toMatchObject({ lines: 20 });
    expect(cli.parseOptions(['--follow', '--errors'])).toMatchObject({ follow: true, errors: true });
  });

  it('a mistyped --dry-run can never degrade into a real deploy', () => {
    // The incident: deploy-kit 0.3.1 had no --dry-run, ignored it, and deployed.
    // Whatever the version, an unrecognised safety flag must now be fatal.
    expect(() => cli.parseOptions(['--dry-run-please'])).toThrow(/Unknown argument/);
    expect(cli.parseOptions(['--dry-run']).dryRun).toBe(true);
  });
});

describe('exec: stdin input seam (injection-safe data passing)', () => {
  it('feeds `input` to the command via execFileSync options, not the shell string', () => {
    let seenOpts: any = null;
    let seenCmd = '';
    const runtime = {
      execFileSync: (_f: string, args: string[], opts: any) => { seenCmd = args[args.length - 1]; seenOpts = opts; return ''; },
    };
    const payload = `{"msg":"has 'quotes' and\nnewlines & $(danger)"}`;
    runOnTarget('send-alert', baseConfig, { runtime, input: payload });
    expect(seenOpts.input).toBe(payload);          // data goes through stdin
    expect(seenCmd).not.toContain('danger');        // never interpolated into the command
    expect(seenCmd).toContain('send-alert');
  });
  it('per-call timeoutSeconds overrides the config bound', () => {
    let seenOpts: any = null;
    const runtime = { execFileSync: (_f: string, _a: string[], opts: any) => { seenOpts = opts; return ''; } };
    runOnTarget('x', mergeConfig(baseConfig, { stepTimeoutSeconds: 1800 }), { runtime, timeoutSeconds: 5 });
    expect(seenOpts.timeout).toBe(5000);
  });
});

describe('monitor config validation', () => {
  const withMon = (mon: any) => validateConfig({ ...baseConfig, monitor: mon }, { source: 'cfg' });
  const okMon = {
    disk: { minFreeKiB: 524288, minFreeInodes: 10000 },
    backup: { id: 'db', stampFile: '/var/lib/app/backups/.last-success', maxAgeHours: 30 },
    restartStorm: { maxDelta: 3 },
    tunnel: true,
    publicProbes: [{ id: 'api', url: 'https://app.example.com/health', expectStatus: 200 }],
    checks: [{ id: 'providers', command: 'curl -sf localhost:3002/ready', level: 'warn' }],
    alert: { command: 'curl -sf -d @- https://app/notify', run: 'controller' },
    failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 15,
    stateFile: '/var/lib/app/deploy-kit-monitor-state.json',
    checkTimeoutSeconds: 20,
  };
  it('accepts a fully-specified valid monitor block', () => {
    expect(withMon(okMon)).toEqual([]);
  });
  it('requires an alert sink command', () => {
    const { alert, ...noAlert } = okMon;
    expect(withMon(noAlert).join('\n')).toMatch(/monitor\.alert\.command.* is required/);
  });
  it('rejects a bad alert.run location', () => {
    expect(withMon({ ...okMon, alert: { command: 'x', run: 'nowhere' } }).join('\n')).toMatch(/alert\.run.*controller.*target/);
  });
  it('rejects duplicate probe/check ids (state would collide)', () => {
    const dup = { ...okMon, checks: [{ id: 'api', command: 'x' }] }; // 'api' already used by a probe
    expect(withMon(dup).join('\n')).toMatch(/duplicate monitor id "api"/);
  });
  it('rejects a probe URL with shell metacharacters', () => {
    expect(withMon({ ...okMon, publicProbes: [{ id: 'x', url: 'https://a/$(rm -rf)' }] }).join('\n')).toMatch(/url must be an http\(s\) URL/);
  });
  it('rejects an unknown monitor key and a bad threshold', () => {
    const probs = withMon({ ...okMon, bogus: 1, failAfterRuns: 0 }).join('\n');
    expect(probs).toMatch(/unknown monitor key "bogus"/);
    expect(probs).toMatch(/monitor\.failAfterRuns.*positive integer/);
  });
  it('rejects shell metacharacters in stateFile and backup.stampFile (injection)', () => {
    expect(withMon({ ...okMon, stateFile: '/var/lib/x; rm -rf /' }).join('\n')).toMatch(/stateFile.*shell metacharacters/);
    expect(withMon({ ...okMon, backup: { id: 'db', stampFile: '/var/lib/$(id)', maxAgeHours: 30 } }).join('\n')).toMatch(/stampFile.*shell metacharacters/);
  });
  it('rejects a single quote in a probe header (would break curl quoting)', () => {
    const bad = { ...okMon, publicProbes: [{ id: 'api', url: 'https://app/health', headers: { Authorization: "Bearer x' ; id" } }] };
    expect(withMon(bad).join('\n')).toMatch(/headers\["Authorization"\].*single quote/);
  });
});

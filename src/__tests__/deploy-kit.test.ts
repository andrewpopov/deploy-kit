import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const { buildTargetCommand, loadConfig, mergeConfig, DEFAULT_CONFIG, deploy, remote } = kit;

// A fake execFileSync that records every command and returns programmed output.
// SSH commands arrive as ('ssh', [host, 'cd dir && <cmd>']); local as ('sh', ['-c', ...]).
function makeRuntime({ fail = [] as string[] } = {}) {
  const calls: string[] = [];
  const execFileSync = (file: string, args: string[]) => {
    const remoteCmd = file === 'ssh' ? args[1] : args[1]; // both put the cmd at [1]
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
    expect(joined).toContain('curl -f -s http://localhost:3000/api/health');
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
      execFileSync: (_file: string, args: string[]) => (args[1].includes('curl') ? '503' : ''),
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

  const tunnelConfig = mergeConfig(baseConfig, {
    tunnelName: 'app-tunnel',
    ensureTunnelOnDeploy: true,
    ecosystemFile: 'ecosystem.config.cjs',
  });

  it('ensureTunnelOnDeploy brings the tunnel up after the app restart', () => {
    const { runtime, calls } = makeRuntime();
    const result = deploy(tunnelConfig, {}, ctxWith(runtime));
    expect(result.steps).toEqual(
      ['stash', 'pull:master', 'install', 'backup', 'migrate', 'build', 'restart', 'tunnel', 'health'],
    );
    const joined = calls.join('\n');
    expect(joined).toContain('pm2 start ecosystem.config.cjs --only app-tunnel 2>/dev/null || pm2 restart app-tunnel');
    // tunnel comes up after the apps, before the health gate
    expect(joined.indexOf('--only app ')).toBeLessThan(joined.indexOf('--only app-tunnel'));
    expect(joined.indexOf('--only app-tunnel')).toBeLessThan(joined.indexOf('curl'));
  });

  it('a tunnel-ensure failure does not abort an otherwise healthy deploy', () => {
    const { runtime } = makeRuntime({ fail: ['app-tunnel'] });
    const result = deploy(tunnelConfig, {}, ctxWith(runtime));
    expect(result.healthy).toBe(true);
    expect(result.steps).toContain('tunnel');
    expect(result.steps).toContain('health');
  });

  it('no tunnel step when ensureTunnelOnDeploy is off, even with a tunnelName', () => {
    const { runtime } = makeRuntime();
    const result = deploy(mergeConfig(baseConfig, { tunnelName: 'app-tunnel' }), {}, ctxWith(runtime));
    expect(result.steps).not.toContain('tunnel');
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
    expect(cmd).toBe("curl -f -s http://localhost:3001/api/health -o /dev/null -w '%{http_code}'");
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
});

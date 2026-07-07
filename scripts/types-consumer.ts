// Consumer-side type contract for src/index.d.ts. This file is NOT run — it is
// type-checked by `npm run verify:types` (tsc --noEmit). If the hand-written
// declarations drift from the JS surface, this fails to compile in CI.
//
// It exercises the public API the way a real consumer (bewks, sano, …) does.
import {
  loadConfig,
  mergeConfig,
  validateConfig,
  deploy,
  rollback,
  init,
  remote,
  buildHealthCommand,
  buildTargetCommand,
  sshHardeningArgs,
  runOnTarget,
  startTunnel,
  makeLogger,
  DEFAULT_CONFIG,
  REMOVED_KEYS,
  type DeployConfig,
  type DeployOptions,
  type RollbackOptions,
  type DeployResult,
  type RollbackResult,
  type HealthCheck,
  type SshOptions,
} from '../src/index';

// Config loads and merges with a typed partial override.
const config: DeployConfig = loadConfig({
  cwd: '/srv/app',
  override: { appNames: ['app', 'worker'], healthChecks: [{ port: 4000, path: '/h' }] },
  validate: true,
  strict: false,
});

const merged: DeployConfig = mergeConfig(DEFAULT_CONFIG, {
  ssh: { connectTimeout: 5, options: ['BatchMode=yes'] },
  stepTimeoutSeconds: 120,
  lock: true,
});

// Validation returns a list of problem strings.
const problems: string[] = validateConfig({ host: 'a@b' }, { source: 'override' });

// The deploy/rollback pipelines take typed options and return typed results.
const deployOpts: DeployOptions = { skipBuild: true, stealLock: false };
const result: DeployResult = deploy(merged, deployOpts, { sleep: () => {}, log: makeLogger() });
const rbOpts: RollbackOptions = { skipDeps: true };
const rb: RollbackResult = rollback(merged, rbOpts);

// Health/exec/remote surface.
const hc: HealthCheck = { port: 3000, path: '/api/health', headers: { A: 'b' } };
const probe: string = buildHealthCommand(config, hc);
const sshArgs: string[] = sshHardeningArgs(config.ssh as SshOptions);
const { file, args } = buildTargetCommand('pm2 status', config);
const ran = runOnTarget('pm2 status', config, { capture: true });
const healthy: boolean = remote.health(config);
const apps: string[] = remote.allApps(config);

// Scaffold + tunnel.
const scaffold = init({ cwd: '/srv/app' });
const tunnel = startTunnel({ configPath: '/etc/cf.yml', tunnelName: 't' });

// Reference the values so tsc doesn't prune the imports as unused.
export const _contract = {
  config, merged, problems, result, rb, probe, sshArgs, file, args, ran,
  healthy, apps, scaffold, tunnel, removed: REMOVED_KEYS,
};

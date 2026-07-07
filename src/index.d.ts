export type DeployMode = 'ssh' | 'local';

export interface DeployHooks {
  install?: string;
  backup?: string | null;
  migrate?: string | null;
  build?: string | null;
  restart?: string | null;
}

export interface PreDeployCheck {
  name: string;
  command: string;
}

export interface HealthCheck {
  port?: number;
  path?: string;
  headers?: Record<string, string>;
}

export interface SshOptions {
  connectTimeout?: number | null;
  serverAliveInterval?: number | null;
  serverAliveCountMax?: number | null;
  options?: string[];
}

export interface DeployConfig {
  host: string | null;
  projectDir: string | null;
  mode: DeployMode;
  remote: string;
  branch: string | null;
  appNames: string[];
  dbBoundApps: string[];
  tunnelName: string | null;
  ensureApps?: string[];
  preDeployChecks?: PreDeployCheck[];
  ecosystemFile?: string | null;
  port: number;
  healthPath: string;
  healthHeaders?: Record<string, string>;
  healthChecks?: HealthCheck[];
  health: { attempts: number; delaySeconds: number };
  ssh?: SshOptions;
  stepTimeoutSeconds?: number | null;
  lock?: boolean;
  buildBeforeMigrate?: boolean;
  hooks: DeployHooks;
}

export interface DeployOptions {
  skipDeps?: boolean;
  skipBuild?: boolean;
  skipMigrate?: boolean;
  stash?: boolean;
  stealLock?: boolean;
  buildBeforeMigrate?: boolean;
}

export interface RollbackOptions {
  skipDeps?: boolean;
  skipBuild?: boolean;
  stealLock?: boolean;
}

export interface RollbackResult {
  sha: string;
  mode: DeployMode;
  host: string | null;
  healthy: boolean;
}

export interface DeployResult {
  branch: string;
  mode: DeployMode;
  host: string | null;
  steps: string[];
  healthy: boolean;
}

export interface Runtime {
  execFileSync?: (file: string, args: string[], options?: unknown) => unknown;
}

export interface DeployContext {
  runtime?: Runtime;
  sleep?: (seconds: number) => void;
  log?: Logger;
}

export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warning(msg: string): void;
  error(msg: string): void;
  step(msg: string): void;
  header(msg: string): void;
  divider(): void;
}

export const CONFIG_FILENAME: string;
export const DEFAULT_CONFIG: DeployConfig;
export const REMOVED_KEYS: Record<string, string>;
export function mergeConfig(base: DeployConfig, override?: Partial<DeployConfig>): DeployConfig;
export function validateConfig(raw: unknown, options?: { source?: string }): string[];
export function loadConfig(options?: {
  cwd?: string;
  override?: Partial<DeployConfig>;
  fsImpl?: unknown;
  validate?: boolean;
  strict?: boolean;
  log?: Logger;
}): DeployConfig;

export const colors: Record<string, string>;
export function makeLogger(out?: (msg: string) => void, err?: (msg: string) => void): Logger;

export function normalizeRuntime(runtime?: Runtime): Required<Runtime>;
export function buildTargetCommand(
  command: string,
  config: Pick<DeployConfig, 'mode' | 'host' | 'projectDir'> & { ssh?: SshOptions },
): { file: string; args: string[] };
export function sshHardeningArgs(ssh?: SshOptions): string[];
export function runOnTarget(
  command: string,
  config: DeployConfig,
  options?: { capture?: boolean; runtime?: Runtime },
): { ok: boolean; output: string; error?: unknown };
export function buildHealthCommand(config: DeployConfig, check?: HealthCheck): string;

export function deploy(config: DeployConfig, options?: DeployOptions, ctx?: DeployContext): DeployResult;
export function rollback(config: DeployConfig, options?: RollbackOptions, ctx?: DeployContext): RollbackResult;
export function resolveBranch(config: DeployConfig, ctx: DeployContext): string;
export function waitForHealth(config: DeployConfig, ctx: DeployContext): boolean;

export function init(options?: { cwd?: string; fsImpl?: unknown; log?: Logger }): {
  configPath: string;
  wrote: boolean;
};

export interface RemoteOps {
  health(config: DeployConfig, ctx?: DeployContext): boolean;
  status(config: DeployConfig, ctx?: DeployContext): boolean;
  logs(config: DeployConfig, options?: { lines?: number; follow?: boolean; errors?: boolean }, ctx?: DeployContext): boolean;
  start(config: DeployConfig, ctx?: DeployContext): boolean;
  stop(config: DeployConfig, ctx?: DeployContext): boolean;
  restart(config: DeployConfig, ctx?: DeployContext): boolean;
  resources(config: DeployConfig, ctx?: DeployContext): boolean;
  gitInfo(config: DeployConfig, ctx?: DeployContext): boolean;
  dashboard(config: DeployConfig, ctx?: DeployContext): boolean;
  allApps(config: DeployConfig): string[];
}
export const remote: RemoteOps;

export function startTunnel(
  options: { configPath: string; tunnelName: string; cloudflaredBin?: string },
  ctx?: { execFileSync?: (file: string, args: string[], options?: unknown) => unknown; fs?: unknown; log?: Logger },
): { tunnelName: string; configPath: string; args: string[] };

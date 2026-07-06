export type DeployMode = 'ssh' | 'local';

export interface DeployHooks {
  install?: string;
  backup?: string | null;
  migrate?: string | null;
  build?: string | null;
  restart?: string | null;
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
  port: number;
  healthPath: string;
  health: { attempts: number; delaySeconds: number };
  buildBeforeMigrate?: boolean;
  hooks: DeployHooks;
}

export interface DeployOptions {
  skipDeps?: boolean;
  skipBuild?: boolean;
  skipMigrate?: boolean;
  stash?: boolean;
  force?: boolean;
  buildBeforeMigrate?: boolean;
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
export function mergeConfig(base: DeployConfig, override?: Partial<DeployConfig>): DeployConfig;
export function loadConfig(options?: {
  cwd?: string;
  override?: Partial<DeployConfig>;
  fsImpl?: unknown;
}): DeployConfig;

export const colors: Record<string, string>;
export function makeLogger(out?: (msg: string) => void, err?: (msg: string) => void): Logger;

export function normalizeRuntime(runtime?: Runtime): Required<Runtime>;
export function buildTargetCommand(
  command: string,
  config: Pick<DeployConfig, 'mode' | 'host' | 'projectDir'>,
): { file: string; args: string[] };
export function runOnTarget(
  command: string,
  config: DeployConfig,
  options?: { capture?: boolean; runtime?: Runtime },
): { ok: boolean; output: string; error?: unknown };

export function deploy(config: DeployConfig, options?: DeployOptions, ctx?: DeployContext): DeployResult;
export function resolveBranch(config: DeployConfig, ctx: DeployContext): string;
export function waitForHealth(config: DeployConfig, ctx: DeployContext): boolean;

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

export type DeployMode = 'ssh' | 'local';

export interface DeployHooks {
  install?: string;
  backup?: string | null;
  migrate?: string | null;
  build?: string | null;
  restart?: string | null;
  /** Restore the pre-migration DB backup during release-layout recovery. Receives
   * the captured backup id as DEPLOY_KIT_BACKUP_ID. null = no auto-restore. */
  restore?: string | null;
}

export interface ReleaseCheck {
  name: string;
  command: string;
}

/** Opt-in artifact-first release layout (SMH-112). Absent = legacy in-place deploy. */
export interface ReleaseLayout {
  type: 'releases';
  /** Releases to retain when pruning (>= 1). Default 4. */
  keepReleases?: number;
  /** Relative paths symlinked from shared/ into every release (dirs, .env, uploads —
   * never node_modules or a bare SQLite file with WAL/SHM sidecars). */
  sharedPaths?: string[];
  /** Commands run INSIDE the candidate release before activation (prisma client
   * loads, entrypoint present). A non-zero exit quarantines the candidate. */
  releaseChecks?: ReleaseCheck[];
  /** Command that returns the SHA the live app reports; asserted == deployed SHA
   * after the flip so an old process answering 200 can't mask a failed activation. */
  runningShaCommand?: string;
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

export interface MonitorPublicProbe {
  /** Stable unique id (alnum . _ -); the per-check state key. */
  id: string;
  /** http(s) URL, no shell metacharacters. */
  url: string;
  expectStatus?: number | number[];
  expectBodyIncludes?: string;
  headers?: Record<string, string>;
  maxTimeSeconds?: number;
}

export interface MonitorCustomCheck {
  /** Stable unique id (alnum . _ -). */
  id: string;
  /** Command run on the target; non-zero exit ⇒ alert at `level`. */
  command: string;
  /** Static severity (severity can't be derived from an exit code). Default 'crit'. */
  level?: 'warn' | 'crit';
}

/** Opt-in fleet monitoring + alerting (SMH-116). Absent = disabled. */
export interface MonitorConfig {
  disk?: { minFreeKiB?: number; minFreeInodes?: number };
  backup?: { id?: string; stampFile: string; maxAgeHours?: number };
  restartStorm?: { maxDelta?: number };
  tunnel?: boolean;
  publicProbes?: MonitorPublicProbe[];
  checks?: MonitorCustomCheck[];
  /** Policy-free alert sink; the batched alert JSON is delivered on stdin.
   * `run` selects where it executes ('controller' = the machine running deploy-kit,
   * 'target' = the monitored host). Default 'controller'. */
  alert: { command: string; run?: 'controller' | 'target' };
  /** Cross-run debounce: consecutive runs a check must fail/recover before alerting. */
  failAfterRuns?: number;
  recoverAfterRuns?: number;
  /** Re-fire a still-failing alert after this many minutes (0 = quiet). */
  reAlertAfterMinutes?: number;
  /** Absolute path to the monitor state file — a STABLE dir, never under releases/. */
  stateFile?: string;
  checkTimeoutSeconds?: number;
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
  /** Per-step wall-clock bound in seconds. Defaults to 1800 (30 min). A hung
   * step would otherwise hold the deploy lock forever, blocking every later
   * deploy. Explicit `null` opts out. */
  stepTimeoutSeconds?: number | null;
  lock?: boolean;
  buildBeforeMigrate?: boolean;
  /** Opt-in artifact-first release layout (SMH-112). Absent/null = legacy in-place. */
  layout?: ReleaseLayout | null;
  /** Opt-in fleet monitoring + alerting (SMH-116). Absent/null = disabled. */
  monitor?: MonitorConfig | null;
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
  /** Resolved deployed commit SHA (release layout only). */
  sha?: string;
  /** Activated release id, `<sha12>-<ts>` (release layout only). */
  release?: string;
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

export interface MonitorCheckResult {
  id: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  message: string;
}
export interface MonitorResult {
  /** 0 = all ok/warn · 1 = a critical condition · 2 = monitor/config/delivery failure. */
  exitCode: 0 | 1 | 2;
  results: MonitorCheckResult[];
  alerts: { id: string; kind: 'alert' | 'recovery' | 'escalation' | 'reminder'; status: string; message: string }[];
}
export function monitor(
  config: DeployConfig,
  options?: { stealLock?: boolean },
  ctx?: DeployContext & { now?: () => number; genId?: (nowMs: number) => string },
): MonitorResult;

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

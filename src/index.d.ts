export type DeployMode = 'ssh' | 'local';

export interface DeployHooks {
  install?: string;
  /** Codegen that writes into node_modules (e.g. `prisma generate`). Runs
   * unconditionally right after install, before build — never fold this into
   * `build`, whose output a build-tool cache (Nx/Turbo) can replay without
   * ever running the underlying command. null = skip. */
  generate?: string | null;
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

export type PostDeployFailurePolicy = 'rollback' | 'remain-active' | 'manual';

export interface PostDeployCheck extends PreDeployCheck {
  /** Required for release layouts. `rollback` restores the prior code release
   * (and the pre-migration backup when a migration ran); `remain-active` keeps
   * the candidate serving but records a degraded deployment; `manual` leaves
   * the verified candidate active and records that an operator decision is due. */
  onFailure?: PostDeployFailurePolicy;
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
  /** -o StrictHostKeyChecking (default 'accept-new'); null omits the flag. */
  strictHostKeyChecking?: string | null;
  /** -o BatchMode (default 'yes'); null omits the flag. */
  batchMode?: string | null;
  /**
   * Extra raw `Key=Value` strings passed as `-o`. Emitted BEFORE the defaults
   * above, so an entry here overrides them — OpenSSH uses the first value it
   * obtains for a repeated option.
   */
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

export interface AutoCutConfig {
  /** Manifest files allowed to advance in the post-cut diff. Default
   * `['package.json', 'package-lock.json']`. */
  manifestFiles?: string[];
  /** Relative paths/dirs the cut is allowed to write the release note/index
   * into. Default: the release-kit config's `notesDir` — which does NOT
   * cover a `changelogTarget` file living outside it (e.g. `CHANGELOG.md` at
   * the repo root); set this explicitly for that case. */
  notePaths?: string[];
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
  /** Named gates run after candidate preparation but before dbBoundApps are
   * stopped. Intended for disposable current-data migration rehearsals: a
   * failure aborts while the live service remains online. */
  preMigrationChecks?: PreDeployCheck[];
  /** Named gates run after health succeeds. Release layouts require an explicit
   * `onFailure` policy for every check. */
  postDeployChecks?: PostDeployCheck[];
  /** Named gates run IMMEDIATELY BEFORE the app restart (legacy: after build, with
   * dbBoundApps still paused; release layout: after the `current` flip). A failure
   * resumes paused apps / runs phase recovery before aborting. Also gates
   * `rollback`'s restart. */
  preRestartChecks?: PreDeployCheck[];
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
  /** Abort the deploy when the target's installed packages disagree with what its
   * package.json pins. Default `true`. Neither `npm install` nor `npm ci`
   * re-resolves a changed `github:owner/repo#ref`, so without this gate a stale
   * dependency ships under a green deploy. */
  verifyPins?: boolean;
  /** Opt-in artifact-first release layout (SMH-112). Absent/null = legacy in-place. */
  layout?: ReleaseLayout | null;
  /** Opt-in fleet monitoring + alerting (SMH-116). Absent/null = disabled. */
  monitor?: MonitorConfig | null;
  /** Opt-in: cut a release via PR on the local controller checkout before either
   * deploy pipeline builds a candidate (see auto-cut.js). `false` (here or via
   * `AutoCutOptions.autoCut`) always wins over a present release-kit config.
   * Absent/null = disabled unless a release-kit.config.{js,cjs} is present AND
   * the caller invokes `autoCut()`. */
  autoCut?: AutoCutConfig | false | null;
  /** Optional target command that receives the post-health deployment JSON on stdin.
   * Under the release layout, also receives the resolved `shared/` directory as
   * DEPLOY_KIT_SHARED_DIR — the one path that survives the release-dir swap, so a
   * hook can record what it already announced there. Unset (not empty) when the
   * layout has no shared directory. */
  deliveryEvent?: { command: string } | null;
  hooks: DeployHooks;
}

export interface DeployOptions {
  skipDeps?: boolean;
  skipBuild?: boolean;
  skipMigrate?: boolean;
  stash?: boolean;
  stealLock?: boolean;
  buildBeforeMigrate?: boolean;
  /** `--skip-pin-check`. Overrides the config's `verifyPins`. */
  verifyPins?: boolean;
}

export interface RollbackOptions {
  skipDeps?: boolean;
  skipBuild?: boolean;
  stealLock?: boolean;
}

/**
 * The two layouts roll back to different things, so exactly one of `sha` /
 * `release` is present. Legacy resets the working tree to the recorded pre-pull
 * SHA; the release layout re-points the `current` symlink at the previous
 * release directory and never touches a SHA.
 */
export type RollbackResult =
  | { sha: string; release?: undefined; mode: DeployMode; host: string | null; healthy: boolean }
  | { release: string; sha?: undefined; mode: DeployMode; host: string | null; healthy: boolean };

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
  /** Present only when `deliveryEvent.command` is configured. `delivered: false`
   * means the command failed -- logged as a warning, but this never fails the
   * deploy (see `deliveryEvent.command` below). */
  deliveryEvent?: { delivered: boolean };
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
  options?: {
    capture?: boolean;
    runtime?: Runtime;
    /** Written to the command's stdin — used to pass JSON without interpolating it. */
    input?: string;
    /** Per-command wall-clock timeout; falls back to config.stepTimeoutSeconds. */
    timeoutSeconds?: number | null;
  },
): {
  ok: boolean;
  /** Captured STDOUT only, so parsers (JSON, df numbers) stay unaffected. */
  output: string;
  /** Captured STDERR. Non-empty ONLY when `capture: true` and the command failed;
   * '' on success, and '' on failure when `capture` is false (stderr was inherited
   * by the terminal, never captured). */
  stderr: string;
  error?: unknown;
};
/** Run a multiline POSIX shell program via stdin, avoiding a controller-shell
 * quoting layer. Use this instead of JSON.stringify(script). */
export function runScriptOnTarget(
  script: string,
  config: DeployConfig,
  options?: {
    capture?: boolean;
    runtime?: Runtime;
    timeoutSeconds?: number | null;
    readOnly?: boolean;
  },
): { ok: boolean; output: string; stderr: string; error?: unknown };
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
  /** true only if every underlying inspection command actually ran and exited 0
   * (an unreachable target returns false, not a printed-nothing true). */
  resources(config: DeployConfig, ctx?: DeployContext): boolean;
  /** true only if every underlying inspection command actually ran and exited 0
   * (an unreachable target returns false, not a printed-nothing true). */
  gitInfo(config: DeployConfig, ctx?: DeployContext): boolean;
  /** Composes status + health + gitInfo; true only if all three succeed. */
  dashboard(config: DeployConfig, ctx?: DeployContext): boolean;
  allApps(config: DeployConfig): string[];
}
export const remote: RemoteOps;

export function startTunnel(
  options: { configPath: string; tunnelName: string; cloudflaredBin?: string },
  ctx?: { execFileSync?: (file: string, args: string[], options?: unknown) => unknown; fs?: unknown; log?: Logger },
): { tunnelName: string; configPath: string; args: string[] };

export interface PortGuardResult {
  ok: boolean;
  message: string;
}
/** Is every process LISTENing on `port` owned by `processName`'s PM2 process tree
 * (its pm2 pid or a descendant, via pgrep -P / ps --ppid)? Free port or all-ours
 * -> ok:true. A foreign listener -> ok:false, naming the squatting PID(s). Neither
 * lsof nor ss present on the host -> ok:false (fails closed; loud). Backs the
 * `deploy-kit port-guard <port> <pm2-process-name>` CLI command. */
export function checkPortGuard(
  port: number,
  processName: string,
  ctx?: { runtime?: Runtime; log?: Logger },
): PortGuardResult;

/** A GitHub-shorthand dependency pin (`github:owner/repo#<ref>` or the bare
 * `owner/repo#<ref>` npm also resolves as GitHub), parsed out of a
 * package.json dependency field. `ref` is null when the specifier has no
 * `#<ref>` at all (pins to the default branch). */
export interface GithubPin {
  owner: string;
  repo: string;
  ref: string | null;
}

/** Parse a dependency specifier into a `GithubPin` if it is a GitHub
 * shorthand pin, else null. Pure — no I/O. */
export function parseGithubSpecifier(specifier: unknown): GithubPin | null;

/** Resolve the INSTALLED package.json for `name` the way node's own require
 * resolution does, but BOUNDED to the project: walk up from `startDir`
 * through node_modules/<name>, stopping once `boundaryDir` (inclusive) has
 * been checked — default `startDir`, i.e. no ancestor walk at all. A `.git`
 * directory is an additional hard ceiling regardless of `boundaryDir`. Pass
 * a workspace root as `boundaryDir` to resolve a nested workspace package's
 * dependency hoisted to that root's node_modules. `null` if never found
 * within the bound; a distinct sentinel object `{ corrupt: true }` if
 * node_modules/<name>/package.json EXISTS but cannot be read/parsed — never
 * folded into `null`, so a broken install is never mistaken for "not
 * installed" (see `VerifyPinsStatus`'s `corrupt`). */
export function resolveInstalled(startDir: string, name: string, boundaryDir?: string): Record<string, unknown> | { corrupt: true } | null;

export type VerifyPinsStatus = 'ok' | 'mismatch' | 'missing' | 'absent' | 'corrupt' | 'unverifiable';

/** One dependency's github: pin checked against what's actually installed.
 * `expectedVersion`/`installedVersion`/`remediation` are present only for the
 * statuses that have them (`unverifiable` and `absent` have no
 * `installedVersion`; `unverifiable` has no `expectedVersion` either;
 * `missing`/`absent` have no `installedVersion`). `manifest` is the
 * repo-relative path (relative to the `verifyPins` root `dir`) of the
 * package.json this pin was read from — the root's own package.json is
 * `"package.json"`; a workspace member is e.g. `"packages/api/package.json"`.
 *
 * `absent`: pinned in `optionalDependencies`/`peerDependencies` and not
 * installed — tolerated, does not fail the run (npm never guarantees either
 * gets installed). `corrupt`: node_modules/<name>/package.json exists but
 * could not be read/parsed — fails the run for EVERY dep field, including
 * optional/peer (a broken install is never "absent"). When the same name is
 * pinned in more than one dep field of the same manifest, only ONE entry is
 * emitted, for the field npm gives effective precedence to — currently just
 * `optionalDependencies` over `dependencies` — see `collectPins`'s
 * `DEP_FIELD_PRECEDENCE` in verify-pins.js. */
export interface VerifyPinsEntry extends GithubPin {
  name: string;
  field: 'dependencies' | 'devDependencies' | 'optionalDependencies' | 'peerDependencies';
  specifier: string;
  status: VerifyPinsStatus;
  manifest: string;
  expectedVersion?: string;
  installedVersion?: string;
  /** The exact `npm install ... --save` command that fixes a mismatch/missing/
   * corrupt pin — npm's known workaround for not re-resolving a bumped tag. */
  remediation?: string;
}

export interface VerifyPinsResult {
  /** false on any `mismatch`, `missing`, or `corrupt` entry — outcomes meaning
   * the manifest and node_modules disagree, or node_modules cannot even be
   * read. An `unverifiable` ref or a tolerated `absent` optional/peer pin
   * never fails this. */
  ok: boolean;
  entries: VerifyPinsEntry[];
  summary: {
    ok: number;
    mismatch: number;
    missing: number;
    unverifiable: number;
    /** Pinned in optionalDependencies/peerDependencies and not installed —
     * tolerated, never fails the run. */
    absent: number;
    /** Installed node_modules/<name>/package.json exists but could not be
     * read/parsed — fails the run for every dep field. */
    corrupt: number;
    /** Total package.json manifests scanned — 1 for a standalone project, or
     * the root plus every workspace member for a workspace root run. */
    manifests: number;
  };
}

/** Check one already-parsed pin against what's installed in `dir`, bounded to
 * `boundaryDir` (default `dir` — see `resolveInstalled`). Exported for the
 * `verifyPins` test suite; `verifyPins` is the entry point that reads
 * package.json and calls this per pin, per manifest. */
export function checkPin(
  pin: GithubPin & { name: string; field: string; specifier: string },
  dir: string,
  boundaryDir?: string,
): Omit<VerifyPinsEntry, 'manifest'>;

/** Read `<dir>/package.json` and assert every GitHub-shorthand pin
 * (dependencies/devDependencies/optionalDependencies/peerDependencies)
 * matches what is actually installed in node_modules — the root manifest AND,
 * if it declares a workspace (npm/yarn `workspaces`, or a
 * pnpm-workspace.yaml), every workspace member manifest too. Never touches
 * the network. Backs the `deploy-kit verify-pins [--dir <path>] [--json]` CLI
 * command. Throws if `<dir>/package.json`, or any workspace member's
 * package.json, cannot be read/parsed. */
export function verifyPins(options?: { dir?: string }): VerifyPinsResult;

/** Format a `verifyPins()` result into human-readable report lines — mismatch/
 * missing/corrupt "problems", "unverifiable" refs, and tolerated-`absent`
 * optional/peer pins are three SEPARATE arrays, since the CLI logs each at
 * its own severity (error / warning / info) — plus the one-line summary.
 * Pure — no I/O. */
export function formatVerifyPinsReport(result: VerifyPinsResult): {
  problemLines: string[];
  unverifiableLines: string[];
  absentLines: string[];
  summaryLine: string;
};

/** Env var read for the Discord webhook URL when `--webhook-env` is not passed. */
export const DEFAULT_WEBHOOK_ENV: string;
export const DEFAULT_SERVICE: string;
export const DISCORD_CONTENT_LIMIT: 2000;
export const MAX_STDIN_BYTES: number;

/** The batched monitor alert event `alert.command` receives on stdin — see
 * `MonitorResult['alerts']` and `monitor.js`'s `deliverAlert`. */
export interface MonitorAlertEvent {
  eventId: string;
  createdAtMs: number;
  host: string;
  alerts: { id: string; kind: 'alert' | 'recovery' | 'escalation' | 'reminder'; status: string; message: string }[];
}

/** Format a monitor alert event into a concise Discord message body (title +
 * failing/recovered checks). Pure — no I/O. */
export function formatDiscordMessage(event: MonitorAlertEvent, options?: { service?: string }): string;

/** Bundled, OPT-IN convenience `alert.command` implementation: reads the monitor's
 * alert JSON from `stdin`, resolves the webhook URL from `env[webhookEnvName]`
 * (default `DEFAULT_WEBHOOK_ENV`), formats it, and POSTs it to Discord. This is a
 * convenience sink, NOT part of the monitor's policy-free contract — monitor.js
 * and checks.js remain unaware Discord exists; a config opts in explicitly via
 * `monitor.alert.command = "npx deploy-kit alert-discord"`. Backs the
 * `deploy-kit alert-discord [--webhook-env NAME] [--service NAME]` CLI command.
 * Non-retryable invalid/empty input is dropped with a zero return so it cannot
 * poison the monitor outbox; unset webhooks and failed/timed-out POSTs remain
 * retryable non-zero delivery failures. Never logs the webhook URL. */
export function alertDiscord(options: {
  stdin: string | null;
  webhookEnvName?: string;
  service?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log: Logger;
}): Promise<0 | 1>;

/** Env var read for the release-announcement Discord webhook URL when
 * `--webhook-env` is not passed. */
export const DEFAULT_RELEASE_WEBHOOK_ENV: string;

/** Claim one allowlisted operations-API request matching `action` and execute
 * this config's deploy pipeline. Generic host-configurable operation runner —
 * `action`, `apiUrl`, and `apiKey` are supplied by the caller, not fixed. */
export function runHostOperations(config: DeployConfig, options: {
  action: string;
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  deployFn?: typeof deploy;
  log?: Pick<Console, 'info' | 'error'>;
}): Promise<{ state: 'idle' } | { state: 'succeeded'; id: string }>;

/** The fixed Cairn operation action used by the deprecated `runCairnOperations` wrapper. */
export const DEPLOY_ACTION: 'DEPLOY_CAIRN_PRODUCTION';

/** @deprecated Use `runHostOperations` with an explicit `action`, `apiUrl`, and
 * `apiKey`. Kept for existing Cairn consumers — supplies the old fixed
 * `DEPLOY_CAIRN_PRODUCTION` action and `CAIRN_OPERATIONS_API_URL` /
 * `CAIRN_OPERATIONS_API_KEY` env var defaults. */
export function runCairnOperations(config: DeployConfig, options?: {
  apiUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  deployFn?: typeof deploy;
  log?: Pick<Console, 'info' | 'error'>;
}): Promise<{ state: 'idle' } | { state: 'succeeded'; id: string }>;

/** The `deliveryEvent.command` payload deploy.js/release.js pipe on stdin after
 * a terminal deployment outcome — see `DeployConfig['deliveryEvent']`. */
export interface DeliveryRecovery {
  policy: PostDeployFailurePolicy;
  outcome: 'rolled-back' | 'remained-active' | 'manual-decision-required' | 'rollback-failed';
  verified: boolean;
}

export interface DeliveryEvent {
  event: 'deployment';
  status: 'succeeded' | 'failed' | 'degraded';
  branch: string;
  /** Attempted deployment revision. */
  revision: string;
  deployedAt: string;
  failedCheck?: string;
  /** Revision currently serving when it is known. A rolled-back release may be
   * identified only by `activeRelease` when its full SHA is unavailable. */
  activeRevision?: string;
  activeRelease?: string;
  recovery?: DeliveryRecovery;
  /** Opaque backup label, never the host-local backup path. Present when a backup hook emits a usable id. */
  backupReference?: string;
}

/** Format a delivery event into a concise Discord release-announcement body
 * ("🚀 `<service>` deployed `<branch>@<shortsha>` at <time>"). Pure — no I/O. */
export function formatReleaseDiscordMessage(event: DeliveryEvent, options?: { service?: string }): string;

/** Bundled, OPT-IN convenience `deliveryEvent.command` implementation: reads the
 * post-deploy delivery event from `stdin`, resolves the webhook URL from
 * `env[webhookEnvName]` (default `DEFAULT_RELEASE_WEBHOOK_ENV`), formats it, and
 * POSTs it to Discord. This is a convenience sink, NOT part of deploy.js's/
 * release.js's policy-free `deliveryEvent` contract — they remain unaware
 * Discord exists; a config opts in explicitly via
 * `deliveryEvent.command = "npx deploy-kit announce-discord"`. Backs the
 * `deploy-kit announce-discord [--webhook-env NAME] [--service NAME]` CLI
 * command.
 *
 * ASYMMETRIC vs `alertDiscord`: a deliveryEvent is already a tolerated,
 * best-effort step, and a release announcement is opt-in decoration on top of
 * an already-succeeded deploy — so every failure mode here (unset webhook env,
 * malformed stdin, a failed/timed-out POST) is a logged warning and exit `0`,
 * never non-zero; a broken/unconfigured announcement must never fail a deploy.
 * Never logs the webhook URL. */
export function announceDiscord(options: {
  stdin: string;
  webhookEnvName?: string;
  service?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  log: Logger;
}): Promise<0>;

/** Relative path (from the project root) of the crash-recovery pointer
 * auto-cut writes right after a merge and clears after the caller's
 * deployment of the resulting SHA succeeds. The consumer project should
 * gitignore it. */
export const PENDING_RELEASE_PATH: string;

export interface AutoCutOptions {
  /** `--dry-run`: report what WOULD be cut, zero local git mutation, zero
   * GitHub write. Auto-cut runs BEFORE `deploy()`'s own dry-run flag is
   * plumbed in, so callers must pass this explicitly. */
  dryRun?: boolean;
  /** `false` always wins over a present release-kit config (skip auto-cut
   * entirely for this run), overriding `config.autoCut`. */
  autoCut?: boolean;
  /** A `--branch` override in play — always aborts; auto-cut only ever
   * targets `config.branch` on the remote's actual default branch. */
  branch?: string;
  /** The local controller checkout to operate in. Default `process.cwd()`. */
  projectRoot?: string;
}

export type AutoCutResult =
  | { ran: false }
  | { ran: false; dryRun: true; fragmentCount: number }
  | { ran: false; fragmentCount: 0 }
  | { ran: true; resumed: true; sha: string; version: string; prNumber: number }
  | { ran: true; sha: string; version: string; prNumber: number; fragmentCount: number };

/** Cut a release via PR on the local controller checkout, before either
 * deploy pipeline builds a candidate, and return the immutable merged SHA the
 * caller should then deploy. See AUTOCUT-SPEC.md for the full flow. */
export function autoCut(
  config: DeployConfig,
  options?: AutoCutOptions,
  ctx?: DeployContext & {
    fs?: unknown;
    now?: () => number;
    /** Resolve `@andrewpopov/release-kit` from the project root. Defaults to
     * `require.resolve`; injectable for tests. */
    resolve?: (name: string, options: { paths: string[] }) => string;
    /** Load a resolved module path. Defaults to `require`; injectable for tests. */
    requireModule?: (path: string) => unknown;
  },
): AutoCutResult;

/** Clear the crash-recovery pointer `autoCut()` wrote — call this only after
 * the caller's deployment of the returned SHA has actually succeeded. */
export function clearAutoCutPending(
  options?: { projectRoot?: string },
  ctx?: { fs?: unknown },
): void;

/** The pending-release pointer as last written by `autoCut()` — `sha`,
 * `version`, `prNumber`, `at`, whatever else `writePendingRelease` recorded. */
export interface PendingRelease {
  sha: string;
  version?: string;
  prNumber?: number;
  at?: string;
  [key: string]: unknown;
}

/** Result of `clearPendingReleasePointer()`. `existed: false` is the
 * idempotent no-op case — nothing to clear, not an error. `corrupt: true`
 * means the file existed but its contents could not be parsed as JSON;
 * `pending` is then absent and `readError` names why. `cleared: false` with
 * `existed: true` means the file could not be removed (see `error`). */
export type ClearPendingReleaseResult =
  | { existed: false; cleared: false }
  | { existed: true; cleared: true; corrupt: false; pending: PendingRelease; readError?: undefined }
  | { existed: true; cleared: true; corrupt: true; pending?: undefined; readError: string }
  | { existed: true; cleared: false; corrupt: boolean; pending?: PendingRelease; error: string };

/** Underlying logic for the `deploy-kit clear-pending-release` CLI verb:
 * report what pending-release pointer is about to be discarded (version,
 * SHA, PR number, timestamp), then discard it. Clearing does NOT unpublish,
 * revert, or un-merge anything — the release named by the pointer stays
 * merged and released. It only means the next deploy stops resuming onto
 * that SHA and instead deploys current HEAD, cutting any pending fragments.
 * Idempotent: no pending pointer is success (`existed: false`), not an
 * error. Reuses `clearAutoCutPending`/`PENDING_RELEASE_PATH` rather than
 * re-deriving the path or the removal logic. */
export function clearPendingReleasePointer(
  options?: { projectRoot?: string },
  ctx?: { fs?: unknown },
): ClearPendingReleaseResult;

export const DEFAULT_GUARD_CONFIG: string;

export interface TunnelRequiredRule {
  hostname: string;
  path: string;
  service: string;
}

export interface TunnelHostnameRule {
  hostname: string;
  service: string;
  allowPath?: boolean;
}

export interface TunnelGuardPolicy {
  configFile: string;
  requiredRules: TunnelRequiredRule[];
  requiredHostnameRules?: TunnelHostnameRule[];
  forbiddenServiceIncludes?: string[];
  requireAnchoredPaths?: boolean;
  finalService?: string;
}

export type SecretPatternKind =
  | 'basename-equals'
  | 'basename-prefix'
  | 'basename-suffix'
  | 'path-segment'
  | 'root-path';

export interface SecretFilePattern {
  name?: string;
  kind: SecretPatternKind;
  value: string;
}

export interface SecretGuardPolicy {
  patterns: SecretFilePattern[];
}

export interface GuardConfig {
  tunnel?: TunnelGuardPolicy;
  secrets?: SecretGuardPolicy;
}

export interface GuardViolation {
  file: string;
  pattern: string;
  reason: string;
}

export interface TunnelGuardResult {
  ok: boolean;
  errors: string[];
  configPath: string;
  checkedRules?: number;
}

export interface SecretGuardResult {
  ok: boolean;
  errors: string[];
  violations: GuardViolation[];
  checkedPatterns?: number;
}

export function loadGuardConfig(options: {
  projectRoot: string;
  configPath?: string;
}): { config: GuardConfig; configPath: string };

export function matchesEveryPath(rule: { path?: unknown }): boolean;
/** Cloudflare Tunnel ingress hostname matching: `ruleHostname` matches
 * `hostname` exactly (case-insensitive, trailing dot significant), or — when
 * it is a `*.example.com` wildcard — matches any one-or-more-label subdomain
 * of `example.com` (case-sensitive), but never the apex `example.com` itself.
 * `ruleHostname` must be a non-empty hostname/pattern; a hostless (catch-all)
 * ingress rule is not represented here — callers check `!rule.hostname`
 * separately. A bare `*` hostname always returns `false`: it is cloudflared's
 * every-hostname wildcard, not a DNS binding, so it never counts as an
 * explicit match — callers needing its every-host reach for shadow detection
 * check `ruleHostname === '*'` separately, the same way they check
 * `!rule.hostname`. */
export function hostnameMatches(ruleHostname: string, hostname: string): boolean;
export function verifyTunnelConfig(options: {
  projectRoot: string;
  policy: TunnelGuardPolicy;
}): TunnelGuardResult;
export function patternMatches(file: string, pattern: SecretFilePattern): boolean;
export function verifyNoSecrets(
  options: { projectRoot: string; policy: SecretGuardPolicy },
  ctx?: { execFileSync?: (file: string, args: string[], options?: unknown) => unknown },
): SecretGuardResult;

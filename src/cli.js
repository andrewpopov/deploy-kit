#!/usr/bin/env node
'use strict';

const path = require('path');
const { loadConfig } = require('./config');
const { log } = require('./log');
const { deploy, rollback } = require('./deploy');
const { init } = require('./init');
const remote = require('./remote');
const { checkPortGuard } = require('./port-guard');
const { alertDiscord, DEFAULT_WEBHOOK_ENV } = require('./alert-discord');
const { announceDiscord, DEFAULT_WEBHOOK_ENV: DEFAULT_RELEASE_WEBHOOK_ENV } = require('./announce-discord');
const { runHostOperations, runCairnOperations } = require('./host-operations');
const { verifyPins, formatReport } = require('./verify-pins');
const { clearPendingReleasePointer, PENDING_RELEASE_PATH } = require('./auto-cut');
const { DEFAULT_GUARD_CONFIG, loadGuardConfig } = require('./guard-config');
const { verifyTunnelConfig } = require('./tunnel-config-guard');
const { verifyNoSecrets } = require('./secret-file-guard');
const { assertShaOptions } = require('./sha-options');
const { markPlanningRuntime } = require('./lock');

const KNOWN_FLAGS = [
  '--lines', '--follow', '--errors', '--skip-build', '--skip-deps',
  '--skip-migrate', '--skip-pin-check', '--no-stash', '--dry-run', '--steal-lock', '--no-lock',
  '--webhook-env', '--service', '--action', '--api-url-env', '--api-key-env',
  '--dir', '--json', '--local', '--branch', '--no-auto-cut', '--guard-config', '--sha', '--on-host',
  '--kind', '--request', '--epoch', '--not-after', '--expect-reservation', '--to', '--run-id', '--parent-run',
];

// Flags that take a following positional value. Kept in sync with the arity
// checks in parseOptions() below — used by usedFlags() to walk raw argv the
// same way parseOptions does, so a flag's VALUE is never mistaken for a flag
// of its own (e.g. `--service --skip-build` must not read `--skip-build` as
// a used flag; parseOptions consumes it as --service's value).
const VALUE_FLAGS = new Set([
  '--lines', '--webhook-env', '--service', '--action', '--api-url-env', '--api-key-env', '--dir', '--branch',
  '--guard-config', '--sha', '--kind', '--request', '--epoch', '--not-after', '--expect-reservation', '--to', '--run-id', '--parent-run',
]);

// The set of flags each command actually reads. KNOWN_FLAGS above is only
// "parses without throwing"; this is "has an effect for this command". The
// gap between the two is the BWK-136 failure mode: `deploy-kit stop
// --dry-run` used to parse fine and then really call remote.stop(), because
// nothing checked that `stop` never reads options.dryRun.
const COMMAND_FLAGS = {
  init: [],
  'alert-discord': ['--webhook-env', '--service'],
  'announce-discord': ['--webhook-env', '--service'],
  'run-host-operations': ['--action', '--api-url-env', '--api-key-env'],
  'run-cairn-operations': [],
  'verify-pins': ['--dir', '--json'],
  'verify-tunnel-config': ['--dir', '--guard-config', '--json'],
  'verify-no-secrets': ['--dir', '--guard-config', '--json'],
  'clear-pending-release': ['--dir', '--json'],
  deploy: ['--skip-build', '--skip-deps', '--skip-migrate', '--skip-pin-check', '--no-stash', '--dry-run', '--steal-lock', '--no-lock', '--branch', '--no-auto-cut', '--sha', '--on-host', '--kind', '--request', '--epoch', '--not-after', '--expect-reservation', '--run-id'],
  rollback: ['--skip-build', '--skip-deps', '--dry-run', '--steal-lock', '--no-lock', '--on-host', '--to', '--kind', '--request', '--epoch', '--not-after', '--expect-reservation', '--run-id'],
  recover: ['--on-host', '--parent-run', '--kind', '--request', '--epoch', '--not-after', '--expect-reservation', '--run-id'],
  monitor: ['--steal-lock', '--no-lock', '--local'],
  status: [],
  health: [],
  dashboard: [],
  resources: [],
  git: [],
  start: [],
  stop: [],
  restart: [],
  logs: ['--lines', '--follow', '--errors'],
};

// Extra actionable guidance appended to the rejection message for specific
// commands, on top of naming the offending flag(s) and the supported set.
const COMMAND_HINTS = {
  'run-cairn-operations': 'Use `deploy-kit run-host-operations --action NAME [--api-url-env ENV] [--api-key-env ENV]` instead.',
};

// Walk raw argv the way parseOptions does, returning just the flag tokens
// actually present (not their values). Assumes args already parsed cleanly
// (parseOptions is always called first and throws on anything malformed).
function usedFlags(args) {
  const used = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      used.push(a);
      if (VALUE_FLAGS.has(a)) i += 1; // skip the value that belongs to this flag
    }
  }
  return used;
}

// Reject any flag the command does not consume. Returns an error message, or
// null if the command's flags are all supported (or the command is unknown —
// the switch's `default` branch below reports that).
function validateCommandFlags(command, args) {
  const supported = COMMAND_FLAGS[command];
  if (!supported) return null;
  const bad = usedFlags(args).filter((f) => !supported.includes(f));
  if (!bad.length) return null;
  const list = supported.length ? supported.join(', ') : '(none)';
  const hint = COMMAND_HINTS[command] ? ` ${COMMAND_HINTS[command]}` : '';
  return `${command} does not support: ${bad.join(', ')}\n${command} supports: ${list}${hint}`;
}

// On-host request flags (BRAIN-636 D4a): raw strings here, validated by on-host/operator.js.
const REQUEST_FLAGS = {
  '--kind': 'kind', '--request': 'request', '--epoch': 'epoch', '--not-after': 'notAfter', '--expect-reservation': 'expectReservation',
  '--run-id': 'runId', '--parent-run': 'parentRun',
};

const PORT_RE = /^[0-9]+$/;

// Reject anything we do not recognise. Silently ignoring an unknown flag is
// dangerous precisely for the flag an operator reaches for when being careful:
// a typo'd `--dry-rn`, or `--dry-run` passed to a version that predates it,
// would otherwise run a FULL PRODUCTION DEPLOY while the operator believes
// nothing will happen. That happened on 2026-07-10 (BWK-136).
// `lock break` flags: --nonce and --reason take a value; --host and --legacy-owner-gone
// are switches. Returns null on anything else (unknown flag, missing value or nonce/reason).
function parseLockBreakArgs(args) {
  const out = { host: false, legacyOwnerGone: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--host') out.host = true;
    else if (a === '--legacy-owner-gone') out.legacyOwnerGone = true;
    else if ((a === '--nonce' || a === '--reason') && i + 1 < args.length) { out[a.slice(2)] = args[i + 1]; i += 1; }
    else return null;
  }
  return out.nonce && out.reason ? out : null;
}

function parseOptions(args) {
  const options = { lines: 50 };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--lines' && args[i + 1]) { options.lines = parseInt(args[i + 1], 10); i += 1; }
    else if (a === '--follow') options.follow = true;
    else if (a === '--errors') options.errors = true;
    else if (a === '--skip-build') options.skipBuild = true;
    else if (a === '--skip-deps') options.skipDeps = true;
    else if (a === '--skip-migrate') options.skipMigrate = true;
    else if (a === '--skip-pin-check') options.verifyPins = false;
    else if (a === '--no-stash') options.stash = false;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--steal-lock') options.stealLock = true;
    else if (a === '--no-lock') options.lock = false;
    else if (a === '--no-auto-cut') options.autoCut = false;
    else if (a === '--on-host') options.onHost = true;
    else if (a === '--webhook-env' && args[i + 1]) { options.webhookEnv = args[i + 1]; i += 1; }
    else if (a === '--service' && args[i + 1]) { options.service = args[i + 1]; i += 1; }
    else if (a === '--action' && args[i + 1]) { options.action = args[i + 1]; i += 1; }
    else if (a === '--api-url-env' && args[i + 1]) { options.apiUrlEnv = args[i + 1]; i += 1; }
    else if (a === '--api-key-env' && args[i + 1]) { options.apiKeyEnv = args[i + 1]; i += 1; }
    else if (a === '--dir' && args[i + 1]) { options.dir = args[i + 1]; i += 1; }
    else if (a === '--branch' && args[i + 1]) { options.branch = args[i + 1]; i += 1; }
    else if (a === '--sha' && args[i + 1]) {
      // Format-checked by the SAME helper deploy()/deployRelease() call --
      // one regex, not two that can drift (PKG-164 review finding 6).
      assertShaOptions({ sha: args[i + 1] });
      options.sha = args[i + 1];
      i += 1;
    }
    else if (a === '--to' && args[i + 1]) { options.to = args[i + 1]; i += 1; }
    else if (REQUEST_FLAGS[a] && args[i + 1]) { options[REQUEST_FLAGS[a]] = args[i + 1]; i += 1; }
    else if (a === '--guard-config' && args[i + 1]) { options.guardConfig = args[i + 1]; i += 1; }
    else if (a === '--json') { options.json = true; }
    else if (a === '--local') { options.local = true; }
    else {
      throw new Error(
        `Unknown argument: ${a}\nValid options: ${KNOWN_FLAGS.join(', ')}`
      );
    }
  }
  return options;
}

const HELP = `deploy-kit — hook-driven deploy + remote PM2 ops

Usage: deploy-kit <command> [options]   (reads .deploy-kit.config.json from cwd)

Commands:
  init                                     scaffold .deploy-kit.config.json + scripts
  port-guard <port> <pm2-process-name>     fail if <port> is held by a process
                                            other than <pm2-process-name>'s pm2 tree
  verify-pins [--dir <path>] [--json]      assert every package.json github: pin
                                            (owner/repo#<semver-tag>) matches what is
                                            actually installed in node_modules — npm
                                            does NOT re-resolve a bumped tag once the
                                            old commit is already resolved in the
                                            lockfile, so a shipped fix can silently
                                            not land. --dir defaults to cwd.
  verify-tunnel-config [--dir <path>]      verify Cloudflare ingress against the
    [--guard-config <path>] [--json]       app-owned tunnel policy in
                                            deploy-kit.guards.json (default)
  verify-no-secrets [--dir <path>]         fail when a configured secret-shaped
    [--guard-config <path>] [--json]       filename is tracked or unignored
  lock inspect [--json]                    print the app lock's owner record and guard
                                            state (read-only; never mutates)
  lock break --nonce <N> --reason <text>   operator-only: remove a held lock after proving
    [--host] [--legacy-owner-gone]         its owner is gone (see README). Exit 0 broken,
                                            3 refused
  layout migrate --to releases|legacy     convert the host between the legacy checkout and the
    [--dry-run]                            release layout, under both locks, with a step journal.
                                            Moves, never copies. Exit 0 verified, 3 refused,
                                            2 failed (journal kept; a rerun refuses)
  clear-pending-release [--dir <path>]     discard the crash-recovery pointer
    [--json]                               auto-cut writes to
                                            .deploy-kit/pending-release.json, so the
                                            next deploy stops resuming onto that SHA
                                            and deploys current HEAD instead. Does NOT
                                            unpublish/revert/un-merge the release the
                                            pointer named — it stays merged and
                                            released. Prints what it discards
                                            (version/sha/PR/timestamp) first.
                                            No-op (exit 0) if nothing is pending. --dir
                                            defaults to cwd. Runs before config is
                                            loaded, so it works even when the deploy
                                            target/config is broken.
  alert-discord [--webhook-env NAME]       convenience alert.command: read bounded
    [--service NAME]                       monitor alert JSON on stdin, post it to
                                            a Discord webhook (env NAME, default
                                            DISCORD_ALERT_WEBHOOK)
  announce-discord [--webhook-env NAME]    convenience deliveryEvent.command:
    [--service NAME]                       read the deploy delivery-event JSON on
                                            stdin, post a release announcement to a
                                            Discord webhook (env NAME, default
                                            DISCORD_RELEASE_WEBHOOK). Opt-in and
                                            unset -> skip (exit 0), never fails a deploy.
  run-host-operations --action NAME        claim one allowlisted operation-API
    [--api-url-env ENV] [--api-key-env ENV] request and run this project's configured deploy
                                            pipeline (env defaults: HOST_OPERATIONS_API_URL /
                                            HOST_OPERATIONS_API_KEY)
  run-cairn-operations                     deprecated alias for run-host-operations with
                                            the Cairn defaults (DEPLOY_CAIRN_PRODUCTION action,
                                            CAIRN_OPERATIONS_API_URL / CAIRN_OPERATIONS_API_KEY);
                                            takes no flags
  deploy [--skip-build|--skip-deps|--skip-migrate|--skip-pin-check]
         [--no-stash] [--dry-run] [--steal-lock] [--no-lock] [--branch NAME]
         [--sha <40-hex-sha>] [--no-auto-cut] [--on-host]
                                            --skip-pin-check disables the post-install
                                            check that the installed tree matches what
                                            package.json pins. It is the escape hatch for
                                            a target you knowingly cannot fix right now —
                                            not a way to make a red deploy green.
                                            --sha deploys EXACTLY that commit (must be a
                                            full 40-char lowercase hex SHA, already merged
                                            onto the deploy branch, and not behind the
                                            target's current HEAD -- use "deploy-kit
                                            rollback" to go backward) instead of the
                                            branch tip a plain pull would resolve.
                                            Mutually exclusive with --branch. Rejected
                                            whenever a release-kit config is present and
                                            auto-cut isn't disabled -- regardless of
                                            whether there is anything to cut -- pass
                                            --no-auto-cut alongside --sha to deploy an
                                            explicit commit on a repo that also has
                                            auto-cut enabled.
                                            --on-host runs the release-layout pipeline ON the host
                                            in a transient systemd user unit, so it survives the
                                            death of this session. Requires --sha and --no-auto-cut,
                                            a releases layout, mode ssh, and lock on; refuses
                                            --dry-run/--no-lock/--steal-lock/--branch. Exit: 0
                                            succeeded, 1 failed/refused, 70 outcome unknown, 75
                                            transport lost or submission unacknowledged (do NOT
                                            redeploy; attach). See README "On-host deploys".
  on-host-status <run-id> [--request <id>] --json
                                           read-only: classify an --on-host run on the host (absent|staged|
                                           claimed|refused|accepted-running|terminal|unknown); exit 75 = transport lost
  hold set --reason <text> [--until <iso>] | hold clear
                                           write or remove the target's deploy hold (locked, as a session
                                           lock owner; refuses lock-held, never waits)
  epoch set <n>                            raise the target's epoch fence (refuses to lower it)
  request cancel <requestId>               tombstone an unstarted deploy request; exit 3 not-cancellable <reason>
  resolve --request <requestId> --reason <text>
                                           clear the app's unresolved record after assessing production (locked, as
                                           a session lock owner); exit 3 not-unresolved / request-mismatch
  target-state --json [--request <id>]     read-only: live sha, journal class, hold, epoch, reservation, lock owners
  attach <run-id>                          follow an --on-host run from the local receipts file
                                            (~/.deploy-kit/on-host-runs.jsonl); same exit codes
  rollback [--skip-build|--skip-deps] [--dry-run] [--steal-lock] [--no-lock]
                                            (NOT --skip-migrate or --no-stash — rollback
                                            never reads them)
  rollback --on-host --to <40-hex> --request <id> --epoch <n> --not-after <unix> --expect-reservation <json>
                                            the controller-driven rollback: refuses unless previous is the --to
                                            release and the current release never migrated
  recover --on-host --parent-run <run-id> --request <id> --epoch <n> --not-after <unix> --expect-reservation <json>
                                            settle the interrupted deploy <run-id> left: runs ONLY the journal
                                            recovery; refuses unless the journal is interrupted and names that
                                            run's release. deploy, rollback and recover also take --run-id <id>
                                            (the controller's run id; refused if that run dir exists on the host)
  artifact --json                          print the installed kit's identity (version + tarball sha256 from
                                            ARTIFACT.json, or source "unpinned")
  monitor [--steal-lock] [--no-lock]       run fleet checks + alert on transitions (cron)
    [--local]                               force mode:'local' for this run — every check
                                            and the alert sink execute on this machine, no
                                            ssh (Since 0.19; for a 24/7 cron running on the
                                            target box against a committed ssh-mode config)
  status | health | dashboard | resources | git   (no flags)
  start | stop | restart                   (no flags — including no --dry-run; these
                                            commands only ever run for real)
  logs [--lines N] [--follow] [--errors]
  help`;

// A deterministic, config-aware planner runtime. It prints every target command
// but executes none of them — including calls marked readOnly. Captured values
// are symbolic yet internally consistent, so release-layout planning reaches
// every phase without needing SSH, a migrated host, PM2, or a real repository.
function dryRunContext(config, options = {}) {
  // `--sha` names the EXACT commit this run must plan against -- every SHA
  // the planner fabricates below (HEAD after the worktree add/merge, a
  // configured `runningShaCommand`, the resolved remote/heads rev-parse) must
  // be THIS one, or the release layout's own `builtSha !== st.sha` validation
  // (release.js) fails a `--sha --dry-run` on fabricated data that was never
  // internally consistent with the SHA the operator actually asked to plan.
  // Without `--sha`, unchanged: the fixed placeholder 'd'.repeat(40).
  const sha = options.sha || 'd'.repeat(40);
  const timestamp = '20990101T000000Z';
  const releaseId = `${sha.slice(0, 12)}-${timestamp}`;
  const candidateDir = `${config.projectDir}/releases/${releaseId}`;
  const currentTarget = 'releases/111111111111-20981231T000000Z';
  const previousTarget = 'releases/222222222222-20981230T000000Z';
  let appsStopped = false;
  // Tracks the target's planned HEAD across a `--sha`/auto-cut fast-forward
  // (`git merge --ff-only 'R'`) -- deploy.js reads `git rev-parse HEAD` right
  // after that merge and asserts it equals R exactly. Only `--sha` can ever
  // reach this under `--dry-run` (auto-cut's own dry-run branch returns
  // before producing an R for this planner to model at all), so this only
  // needs to track ONE fast-forward per run, never a chain of them.
  let headSha = sha;
  const plannedOutput = (rendered) => {
    if (rendered.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (rendered.includes('.deploy-kit-state.json') && rendered.includes('cat ')) return '';
    if (rendered.includes('mv --version')) return 'mv (GNU coreutils) 9.0';
    if (rendered.includes('df -kP')) return '99999999';
    if (rendered.includes('rev-parse --abbrev-ref')) return config.branch || 'master';
    // Only reached under `--sha --dry-run` (auto-cut's own dry-run branch
    // returns before ever producing an R for this planner to model) -- the
    // target is symbolically "on the deploy branch" for planning purposes.
    if (rendered.includes('symbolic-ref -q --short HEAD')) return config.branch || 'master';
    if (rendered.includes('rev-parse refs/heads/') || rendered.includes(`rev-parse '${config.remote}'/`)) return sha;
    // `requireVerifiedRef`'s tip read (verified-ref.js): the planned sha IS the verified tip.
    if (config.requireVerifiedRef && rendered.includes('rev-parse --verify --quiet')) return sha;
    if (rendered.includes('date -u +%Y%m%dT%H%M%SZ')) return timestamp;
    if (rendered.includes('git rev-parse HEAD')) return headSha;
    if (rendered.includes(`readlink ${config.projectDir}/current`)) return currentTarget;
    if (rendered.includes(`readlink ${config.projectDir}/previous`)) return previousTarget;
    if (rendered.includes('readlink -f /proc/')) return candidateDir;
    if (rendered.includes('readlink -f ')) return candidateDir;
    if (config.layout?.runningShaCommand && rendered.includes(config.layout.runningShaCommand)) return sha;
    if (rendered.includes('pm2 jlist')) {
      return JSON.stringify((config.appNames || []).map((name, index) => ({
        name,
        pid: 1000 + index,
        pm2_env: { status: appsStopped ? 'stopped' : 'online', restart_time: 0 },
      })));
    }
    if (config.hooks?.backup && rendered.includes(config.hooks.backup)) return 'dry-run-backup-20990101';
    if (rendered.includes(`ls -1 ${config.projectDir}/releases`)) {
      return `${releaseId}\n${currentTarget.slice('releases/'.length)}\n${previousTarget.slice('releases/'.length)}`;
    }
    if (rendered.includes('curl')) return '200';
    return '';
  };
  const executePlan = (file, args) => {
    const rendered = [file, ...args].join(' ');
    log.step(`[dry-run] ${rendered}`);
    if (rendered.includes('pm2 stop ')) appsStopped = true;
    if (/pm2 (startOrRestart|start|restart) /.test(rendered)) appsStopped = false;
    const mergeMatch = rendered.match(/git merge --ff-only '([0-9a-f]{7,64})'/);
    if (mergeMatch) headSha = mergeMatch[1];
    return plannedOutput(rendered);
  };
  return {
    sleep: () => {},
    runtime: markPlanningRuntime({
      dryRun: true,
      execFileSync: executePlan,
      // runOnTarget normally sends readOnly dry-run probes through this seam.
      // Point it at the same planner so even preflight cannot contact the host.
      realExecFileSync: executePlan,
    }),
  };
}

// Drain a stream to a string with an optional memory bound. Injected as `stdin`
// so alert-discord is testable without a real process.stdin.
function readStdin(stream, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    let exceeded = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      if (exceeded) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        exceeded = true;
        data = '';
        return;
      }
      data += chunk;
    });
    stream.on('end', () => resolve(exceeded ? null : data));
    stream.on('error', reject);
  });
}

function run(argv = process.argv.slice(2), { cwd = process.cwd(), stdin = process.stdin, env = process.env, fetchImpl } = {}) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }

  // port-guard takes POSITIONAL args (<port> <pm2-name>) and does its own parsing
  // below. It must be dispatched BEFORE the generic parseOptions() flag validation,
  // which only knows deploy/monitor flags and would otherwise reject the positional
  // <port> as "Unknown argument" (BRAIN: caught only in a real deploy — the guard's
  // function was unit-tested but the CLI subcommand invocation was not).
  if (command === 'port-guard') {
    const rest = argv.slice(1);
    // No flags — loud rejection matches every other command (an unrecognised
    // `--foo` here must never be silently ignored while the guard passes anyway).
    const badFlag = rest.find((a) => a.startsWith('-'));
    if (badFlag) {
      log.error(`Unknown argument: ${badFlag}\nUsage: deploy-kit port-guard <port> <pm2-process-name>`);
      return 1;
    }
    const [portArg, processName] = rest;
    const port = Number(portArg);
    if (!portArg || !PORT_RE.test(portArg) || !Number.isInteger(port) || port < 1 || port > 65535) {
      log.error(`Invalid <port>: "${portArg || ''}"\nUsage: deploy-kit port-guard <port> <pm2-process-name>`);
      return 1;
    }
    if (!processName) {
      log.error('Missing <pm2-process-name>\nUsage: deploy-kit port-guard <port> <pm2-process-name>');
      return 1;
    }
    const result = checkPortGuard(port, processName, { log });
    if (result.ok) { log.success(result.message); return 0; }
    log.error(result.message);
    return 1;
  }

  // artifact: the installed kit's identity (BRAIN-636 D8). No config, no banner: stdout is only the JSON.
  if (command === 'artifact') {
    const rest = argv.slice(1);
    if (rest.length !== 1 || rest[0] !== '--json') {
      log.error('Usage: deploy-kit artifact --json');
      return 1;
    }
    try {
      console.log(JSON.stringify(require('./artifact').readArtifact(), null, 2));
      return 0;
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  // host-run takes a positional <runDir>, like port-guard, and is invoked only by
  // the on-host systemd unit: no config load, no banner, no flags.
  if (command === 'host-run') {
    const rest = argv.slice(1);
    if (rest.length !== 1 || rest[0].startsWith('-')) {
      log.error('Usage: deploy-kit host-run <runDir>');
      return 1;
    }
    return require('./on-host/host-run').hostRun(rest[0], { env });
  }

  // attach takes a positional <run-id>, like host-run; it needs the config only for its ssh options.
  if (command === 'attach') {
    const rest = argv.slice(1);
    if (rest.length !== 1 || rest[0].startsWith('-')) {
      log.error('Usage: deploy-kit attach <run-id>');
      return 1;
    }
    let attachConfig;
    try {
      attachConfig = loadConfig({ cwd });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    return require('./on-host/attach').attachRun(rest[0], attachConfig);
  }

  // on-host-status takes a positional <run-id> like attach; read-only, always prints JSON.
  if (command === 'on-host-status') {
    const rest = argv.slice(1);
    const positional = [];
    let requestId;
    let usage = false;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--json') continue;
      if (rest[i] === '--request') {
        i += 1;
        requestId = rest[i];
        if (requestId === undefined || requestId.startsWith('-')) usage = true;
      } else if (rest[i].startsWith('-')) usage = true;
      else positional.push(rest[i]);
    }
    if (usage || positional.length !== 1) {
      log.error('Usage: deploy-kit on-host-status <run-id> [--request <id>] --json');
      return 1;
    }
    try {
      const status = require('./on-host/status').onHostStatus(loadConfig({ cwd }), positional[0], { requestId });
      console.log(JSON.stringify(status, null, 2));
      return status.transport === 'lost' ? 75 : 0;
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  // lock takes a positional subcommand, so it is dispatched before parseOptions
  // like attach. `inspect` is read-only; `break` is the operator-only removal that
  // first proves the owner is gone (exit 0 broken, 3 refused, 1 usage or failure).
  if (command === 'lock') {
    const rest = argv.slice(1);
    const lockUsage = 'Usage: deploy-kit lock inspect [--json] | deploy-kit lock break --nonce <N> --reason <text> [--host] [--legacy-owner-gone]';
    if (rest[0] === 'break') {
      const parsed = parseLockBreakArgs(rest.slice(1));
      if (!parsed) {
        log.error(lockUsage);
        return 1;
      }
      try {
        const result = require('./lock-break').breakLock(loadConfig({ cwd }), {}, parsed);
        console.log(result.output);
        return result.broken ? 0 : require('./lock-break').REFUSED_EXIT;
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }
    if (rest[0] !== 'inspect' || rest.slice(1).some((a) => a !== '--json')) {
      log.error(lockUsage);
      return 1;
    }
    try {
      const report = require('./lock').inspectLock(loadConfig({ cwd }), {});
      console.log(JSON.stringify(report, null, 2));
      return 0;
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  // layout migrate (BRAIN-636 D9) takes a positional subcommand like lock, so it is dispatched before
  // parseOptions. Exit 0 verified (or a clean dry run), 3 refused, 2 failed with the journal left in place.
  if (command === 'layout') {
    const rest = argv.slice(1);
    const toIndex = rest.indexOf('--to');
    const to = toIndex >= 0 ? rest[toIndex + 1] : undefined;
    const extra = rest.filter((a, i) => i > 0 && i !== toIndex && i !== toIndex + 1 && a !== '--dry-run');
    if (rest[0] !== 'migrate' || !['releases', 'legacy'].includes(to) || extra.length) {
      log.error('Usage: deploy-kit layout migrate --to releases|legacy [--dry-run]');
      return 1;
    }
    try {
      const { migrateLayout } = require('./layout-migrate');
      const { exitCode, result } = migrateLayout(loadConfig({ cwd }), { to, dryRun: rest.includes('--dry-run') }, { env, log });
      console.log(JSON.stringify(result, null, 2));
      return exitCode;
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  // Target-state commands (BRAIN-636 D3): holds, the epoch fence, request cancel, and the read-only state.
  if (['hold', 'epoch', 'request', 'resolve', 'target-state'].includes(command)) {
    let targetConfig;
    try {
      targetConfig = loadConfig({ cwd });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    return require('./target-state').runCommand(command, argv.slice(1), targetConfig, { log });
  }

  const options = parseOptions(argv.slice(1));

  // Reject any flag this command does not consume, BEFORE any side effect
  // (the version banner below, loadConfig, or dispatch) has run. See
  // COMMAND_FLAGS above for the BWK-136 rationale.
  const flagError = validateCommandFlags(command, argv.slice(1));
  if (flagError) {
    log.error(flagError);
    return 1;
  }

  // --sha names an exact commit; --branch names an override branch tip. Both
  // together is ambiguous about what the operator actually wants deployed --
  // reject before any side effect, same as every other rejection above. The
  // SAME helper deploy()/deployRelease() call at their own entry point, so
  // there is one exclusivity rule, not two (PKG-164 review finding 6).
  if (command === 'deploy') {
    try {
      assertShaOptions(options);
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  // Surface the resolved version: a stale node_modules (manifest pinned newer
  // than what is installed) is otherwise invisible until a flag silently
  // misbehaves. See BRAIN-18 — `npm install` does not re-resolve a github: tag.
  //
  // This banner is only a HINT, and only about deploy-kit itself — it relies on
  // an operator noticing a wrong number. `verify-pins` (PKG-108) is the actual
  // assertion, and covers every github: pin in the project rather than just
  // this one. Prefer it for gating; the banner stays because the running
  // version is worth having in the log regardless.
  //
  // Suppressed under `--json`: log.info writes to stdout (see log.js), and
  // `--json` promises stdout is ONLY the JSON document so `verify-pins --json
  // | jq` works (PKG-108 finding 3 — the banner used to precede the JSON and
  // broke every consumer of --json). `options.json` can only be true here for
  // `verify-pins` — it's the only command in COMMAND_FLAGS that accepts
  // `--json`, and validateCommandFlags() above already rejected it for any
  // other command before this line runs.
  if (!options.dryRun && !options.json) {
    log.info(`deploy-kit v${require('../package.json').version}`);
  }

  if (command === 'init') {
    init({ cwd });
    return 0;
  }

  // alert-discord takes no positional args (only the generic `--webhook-env`
  // and `--service` flags), so — unlike port-guard — it is safe to dispatch AFTER parseOptions;
  // there is no positional value for the generic validator to misparse. It is
  // still dispatched here, before loadConfig, because it is a standalone utility:
  // it does not read .deploy-kit.config.json and must not fail an operator who
  // runs it outside a project directory.
  if (command === 'alert-discord') {
    const { MAX_STDIN_BYTES } = require('./alert-discord');
    return readStdin(stdin, MAX_STDIN_BYTES).then((data) => alertDiscord({
      stdin: data,
      webhookEnvName: options.webhookEnv || DEFAULT_WEBHOOK_ENV,
      service: options.service,
      env,
      fetchImpl,
      log,
    }));
  }

  // announce-discord takes no positional args (only the now-generic
  // `--webhook-env`/`--service` flags), so — like alert-discord — it is safe to
  // dispatch AFTER parseOptions. It is dispatched here, before loadConfig,
  // because it is a standalone utility: it does not read
  // .deploy-kit.config.json and must not fail an operator who runs it outside
  // a project directory.
  if (command === 'announce-discord') {
    return readStdin(stdin).then((data) => announceDiscord({
      stdin: data,
      webhookEnvName: options.webhookEnv || DEFAULT_RELEASE_WEBHOOK_ENV,
      service: options.service,
      env,
      fetchImpl,
      log,
    }));
  }

  // verify-pins takes no positional args (only the generic `--dir`/`--json`
  // flags), so — like alert-discord/announce-discord — it is safe to dispatch
  // AFTER parseOptions. Dispatched here, before loadConfig, because it is a
  // standalone utility: it checks ANY directory's package.json against its
  // node_modules, not a deploy-kit project, and must not require
  // .deploy-kit.config.json to exist.
  if (command === 'verify-pins') {
    let result;
    try {
      result = verifyPins({ dir: path.resolve(cwd, options.dir || '.') });
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    const {
      problemLines, unverifiableLines, absentLines, summaryLine,
    } = formatReport(result);
    for (const line of problemLines) log.error(line);
    for (const line of unverifiableLines) log.warning(line);
    for (const line of absentLines) log.info(line);
    if (result.ok) log.success(summaryLine); else log.error(summaryLine);
    return result.ok ? 0 : 1;
  }

  if (command === 'verify-tunnel-config' || command === 'verify-no-secrets') {
    const projectRoot = path.resolve(cwd, options.dir || '.');
    let result;
    try {
      const { config: guardConfig } = loadGuardConfig({
        projectRoot,
        configPath: options.guardConfig || DEFAULT_GUARD_CONFIG,
      });
      result = command === 'verify-tunnel-config'
        ? verifyTunnelConfig({ projectRoot, policy: guardConfig.tunnel })
        : verifyNoSecrets({ projectRoot, policy: guardConfig.secrets });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ ok: false, errors: [message] }, null, 2));
      else log.error(`${command}: ${message}`);
      return 1;
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    for (const error of result.errors ?? []) log.error(error);
    for (const violation of result.violations ?? []) {
      log.error(`${violation.file} (matches "${violation.pattern}", ${violation.reason})`);
    }
    if (result.ok) {
      const count = command === 'verify-tunnel-config'
        ? result.checkedRules
        : result.checkedPatterns;
      log.success(`${command}: ${count} configured rule(s) passed`);
      return 0;
    }
    const count = (result.errors?.length ?? 0) + (result.violations?.length ?? 0);
    log.error(`${command}: ${count} issue(s) found`);
    return 1;
  }

  // clear-pending-release takes no positional args (only the generic
  // `--dir`/`--json` flags), so it is safe to dispatch AFTER parseOptions.
  // Dispatched here, before loadConfig, on purpose: an operator reaches for
  // this verb precisely when a deploy is stuck, which is exactly the
  // situation where .deploy-kit.config.json or the target may be broken or
  // unreachable — clearing a local pointer must not depend on either.
  if (command === 'clear-pending-release') {
    const projectRoot = path.resolve(cwd, options.dir || '.');
    let result;
    try {
      result = clearPendingReleasePointer({ projectRoot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) console.log(JSON.stringify({ existed: true, cleared: false, error: message }, null, 2));
      else log.error(`clear-pending-release: ${message}`);
      return 1;
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return result.existed && !result.cleared ? 1 : 0;
    }
    if (!result.existed) {
      log.success(`clear-pending-release: no pending release pointer at ${PENDING_RELEASE_PATH} — nothing to clear.`);
      return 0;
    }
    if (result.corrupt) {
      log.warning(`clear-pending-release: ${PENDING_RELEASE_PATH} exists but its contents could not be parsed (${result.readError || result.error}).`);
    } else {
      const { pending } = result;
      log.info(`clear-pending-release: discarding pointer to version ${pending.version || '(unknown)'}, sha ${pending.sha}, PR #${pending.prNumber != null ? pending.prNumber : '(unknown)'}, recorded at ${pending.at || '(unknown)'}.`);
    }
    log.info('This does NOT unpublish, revert, or un-merge that release — it stays merged and released. '
      + 'It only means the next deploy stops resuming onto that SHA and instead deploys current HEAD, cutting any pending fragments.');
    if (!result.cleared) {
      log.error(`clear-pending-release: could not remove ${PENDING_RELEASE_PATH}: ${result.error}`);
      return 1;
    }
    log.success(`clear-pending-release: removed ${PENDING_RELEASE_PATH}.`);
    return 0;
  }

  // --local is monitor-only (enforced above by COMMAND_FLAGS): forces mode:'local'
  // via loadConfig's validated override param rather than mutating the loaded
  // config afterward, so the same validation that applies to a config file also
  // applies here. `host` is left untouched — it still identifies the target in
  // the monitor header/alert event even when the run itself is local.
  const configOverride = {};
  if (command === 'monitor' && options.local) configOverride.mode = 'local';
  if (command === 'deploy' && options.branch) configOverride.branch = options.branch;

  let config;
  try {
    config = loadConfig({ cwd, override: configOverride });
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (options.lock === false) config = { ...config, lock: false };

  // An onHost.required app deploys and rolls back only as an accepted request (`--on-host`), under owned locks.
  // `--dry-run` is the config-only planner: it opens no ssh and runs no target command (dryRunContext), so it is not an execution.
  if (['deploy', 'rollback'].includes(command) && !(options.dryRun && !options.onHost) && require('./lock').lockRequiresOwnership(config)) {
    const refusal = !options.onHost
      ? `${command}: this app sets onHost.required, so it only runs as \`deploy-kit ${command} --on-host ...\` (an accepted request under the host and app locks)`
      : (options.stealLock || options.lock === false) && `${command}: --steal-lock and --no-lock are refused for an onHost.required app`;
    if (refusal) {
      log.error(refusal);
      return 1;
    }
  }

  if (command === 'deploy' && options.onHost) {
    return require('./on-host/operator').onHostDeploy(config, options, { cwd });
  }
  if (command === 'deploy' && !options.onHost && options.runId !== undefined) {
    log.error('deploy: --run-id only applies with --on-host');
    return 1;
  }
  if (command === 'rollback' && !options.onHost) {
    const requestFlags = ['to', 'kind', 'request', 'epoch', 'notAfter', 'expectReservation', 'runId'].filter((key) => options[key] !== undefined);
    if (requestFlags.length > 0) {
      log.error('rollback: --to and the request flags only apply with --on-host; without it rollback returns to `previous`, whatever it is');
      return 1;
    }
  }
  if (command === 'rollback' && options.onHost) {
    return require('./on-host/operator').onHostRollback(config, options, { cwd });
  }
  if (command === 'recover') {
    if (!options.onHost) {
      log.error('recover only exists as `recover --on-host`: it settles an interrupted on-host deploy');
      return 1;
    }
    return require('./on-host/operator').onHostRecover(config, options, { cwd });
  }

  switch (command) {
    case 'deploy':
      try {
        // projectRoot anchors auto-cut's release-kit.config.* lookup to the
        // directory the CLI actually resolved `.deploy-kit.config.json` from,
        // not whatever `process.cwd()` happens to be inside the process --
        // without this, auto-cut() would default to `process.cwd()` itself
        // (see auto-cut.js), which is wrong for anything invoking the CLI
        // programmatically (or under test) from a different working directory
        // than `cwd`.
        deploy(config, { ...options, projectRoot: cwd }, options.dryRun ? dryRunContext(config, options) : {});
        return 0;
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    case 'rollback':
      try {
        rollback(config, options, options.dryRun ? dryRunContext(config) : {});
        return 0;
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    case 'monitor':
      try {
        if (!config.monitor) {
          log.error('No `monitor` config block — add one to enable `deploy-kit monitor` (see MonitorConfig).');
          return 2;
        }
        return require('./ssh-mux').withSshMux(config, (c) => require('./monitor').monitor(c, options)).exitCode; // 0 ok/warn · 1 crit · 2 monitor error
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        return 2;
      }
    case 'run-host-operations':
      if (!options.action) {
        log.error('Missing --action\nUsage: deploy-kit run-host-operations --action NAME [--api-url-env ENV] [--api-key-env ENV]');
        return 1;
      }
      return runHostOperations(config, {
        action: options.action,
        apiUrl: env[options.apiUrlEnv || 'HOST_OPERATIONS_API_URL'],
        apiKey: env[options.apiKeyEnv || 'HOST_OPERATIONS_API_KEY'],
      }).then(() => 0).catch((error) => {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      });
    // Deprecated alias — supplies the old fixed Cairn defaults. See
    // host-operations.js. Its flag rejection (it takes none — accepting the
    // new generic flags and silently ignoring them would be the BWK-136
    // failure mode again) is handled generically above via COMMAND_FLAGS.
    case 'run-cairn-operations':
      return runCairnOperations(config, {
        apiUrl: env.CAIRN_OPERATIONS_API_URL,
        apiKey: env.CAIRN_OPERATIONS_API_KEY,
      }).then(() => 0).catch((error) => {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      });
    case 'status': return remote.status(config) ? 0 : 1;
    case 'health': return remote.health(config) ? 0 : 1;
    case 'dashboard': return remote.dashboard(config) ? 0 : 1;
    case 'resources': return remote.resources(config) ? 0 : 1;
    case 'git': return remote.gitInfo(config) ? 0 : 1;
    case 'start': return remote.start(config) ? 0 : 1;
    case 'stop': return remote.stop(config) ? 0 : 1;
    case 'restart': return remote.restart(config) ? 0 : 1;
    case 'logs': return remote.logs(config, options) ? 0 : 1;
    default:
      log.error(`Unknown command: ${command}`);
      console.log(HELP);
      return 1;
  }
}

if (require.main === module) {
  // run() is synchronous for every command except alert-discord/announce-discord,
  // which return a Promise (they await stdin + the Discord POST).
  // Promise.resolve(...).then(...) handles both: a plain number resolves
  // immediately, a Promise<number> awaits.
  Promise.resolve()
    .then(() => run())
    .then((code) => process.exit(code))
    .catch((error) => {
      // A bad argument is an operator mistake, not a crash. Print it the way an
      // unknown COMMAND is printed, and exit non-zero.
      log.error(error.message);
      process.exit(1);
    });
}

module.exports = { run, parseOptions, dryRunContext };

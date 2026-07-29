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

const KNOWN_FLAGS = [
  '--lines', '--follow', '--errors', '--skip-build', '--skip-deps',
  '--skip-migrate', '--no-stash', '--dry-run', '--steal-lock', '--no-lock',
  '--webhook-env', '--service', '--action', '--api-url-env', '--api-key-env',
  '--dir', '--json',
];

// Flags that take a following positional value. Kept in sync with the arity
// checks in parseOptions() below — used by usedFlags() to walk raw argv the
// same way parseOptions does, so a flag's VALUE is never mistaken for a flag
// of its own (e.g. `--service --skip-build` must not read `--skip-build` as
// a used flag; parseOptions consumes it as --service's value).
const VALUE_FLAGS = new Set([
  '--lines', '--webhook-env', '--service', '--action', '--api-url-env', '--api-key-env', '--dir',
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
  deploy: ['--skip-build', '--skip-deps', '--skip-migrate', '--no-stash', '--dry-run', '--steal-lock', '--no-lock'],
  rollback: ['--skip-build', '--skip-deps', '--dry-run', '--steal-lock', '--no-lock'],
  monitor: ['--steal-lock', '--no-lock'],
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

const PORT_RE = /^[0-9]+$/;

// Reject anything we do not recognise. Silently ignoring an unknown flag is
// dangerous precisely for the flag an operator reaches for when being careful:
// a typo'd `--dry-rn`, or `--dry-run` passed to a version that predates it,
// would otherwise run a FULL PRODUCTION DEPLOY while the operator believes
// nothing will happen. That happened on 2026-07-10 (BWK-136).
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
    else if (a === '--no-stash') options.stash = false;
    else if (a === '--dry-run') options.dryRun = true;
    else if (a === '--steal-lock') options.stealLock = true;
    else if (a === '--no-lock') options.lock = false;
    else if (a === '--webhook-env' && args[i + 1]) { options.webhookEnv = args[i + 1]; i += 1; }
    else if (a === '--service' && args[i + 1]) { options.service = args[i + 1]; i += 1; }
    else if (a === '--action' && args[i + 1]) { options.action = args[i + 1]; i += 1; }
    else if (a === '--api-url-env' && args[i + 1]) { options.apiUrlEnv = args[i + 1]; i += 1; }
    else if (a === '--api-key-env' && args[i + 1]) { options.apiKeyEnv = args[i + 1]; i += 1; }
    else if (a === '--dir' && args[i + 1]) { options.dir = args[i + 1]; i += 1; }
    else if (a === '--json') { options.json = true; }
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
  deploy [--skip-build|--skip-deps|--skip-migrate]
         [--no-stash] [--dry-run] [--steal-lock] [--no-lock]
  rollback [--skip-build|--skip-deps] [--dry-run] [--steal-lock] [--no-lock]
                                            (NOT --skip-migrate or --no-stash — rollback
                                            never reads them)
  monitor [--steal-lock] [--no-lock]       run fleet checks + alert on transitions (cron)
  status | health | dashboard | resources | git   (no flags)
  start | stop | restart                   (no flags — including no --dry-run; these
                                            commands only ever run for real)
  logs [--lines N] [--follow] [--errors]
  help`;

// A runtime that prints the exact command stream instead of executing it. Health
// probes return 200 so a dry-run walks the full happy path.
function dryRunContext() {
  return {
    sleep: () => {},
    runtime: {
      execFileSync: (file, args) => {
        const rendered = [file, ...args].join(' ');
        log.step(`[dry-run] ${rendered}`);
        return /curl/.test(rendered) ? '200' : '';
      },
    },
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

  const options = parseOptions(argv.slice(1));

  // Reject any flag this command does not consume, BEFORE any side effect
  // (the version banner below, loadConfig, or dispatch) has run. See
  // COMMAND_FLAGS above for the BWK-136 rationale.
  const flagError = validateCommandFlags(command, argv.slice(1));
  if (flagError) {
    log.error(flagError);
    return 1;
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
    const { problemLines, unverifiableLines, summaryLine } = formatReport(result);
    for (const line of problemLines) log.error(line);
    for (const line of unverifiableLines) log.warning(line);
    if (result.ok) log.success(summaryLine); else log.error(summaryLine);
    return result.ok ? 0 : 1;
  }

  let config;
  try {
    config = loadConfig({ cwd });
  } catch (error) {
    log.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  if (options.lock === false) config = { ...config, lock: false };

  switch (command) {
    case 'deploy':
      try {
        deploy(config, options, options.dryRun ? dryRunContext() : {});
        return 0;
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    case 'rollback':
      try {
        rollback(config, options, options.dryRun ? dryRunContext() : {});
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
        return require('./monitor').monitor(config, options).exitCode; // 0 ok/warn · 1 crit · 2 monitor error
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

module.exports = { run, parseOptions };

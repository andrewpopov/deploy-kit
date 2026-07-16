#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { log } = require('./log');
const { deploy, rollback } = require('./deploy');
const { init } = require('./init');
const remote = require('./remote');
const { checkPortGuard } = require('./port-guard');
const { alertDiscord, DEFAULT_WEBHOOK_ENV } = require('./alert-discord');
const { announceDiscord, DEFAULT_WEBHOOK_ENV: DEFAULT_RELEASE_WEBHOOK_ENV } = require('./announce-discord');
const { runCairnOperations } = require('./cairn-operations');

const KNOWN_FLAGS = [
  '--lines', '--follow', '--errors', '--skip-build', '--skip-deps',
  '--skip-migrate', '--no-stash', '--dry-run', '--steal-lock', '--no-lock',
  '--webhook-env', '--service',
];

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
  run-cairn-operations                     claim one allowlisted Cairn operation
                                            and run this project's configured deploy pipeline
  deploy [--skip-build|--skip-deps|--skip-migrate]
         [--no-stash] [--dry-run] [--steal-lock] [--no-lock]
  rollback [--skip-build|--skip-deps] [--steal-lock]
  monitor                                  run fleet checks + alert on transitions (cron)
  status | health | dashboard | resources | git
  start | stop | restart
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
  // Surface the resolved version: a stale node_modules (manifest pinned newer
  // than what is installed) is otherwise invisible until a flag silently
  // misbehaves. See BRAIN-18 — `npm install` does not re-resolve a github: tag.
  if (!options.dryRun) {
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

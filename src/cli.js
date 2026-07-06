#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { log } = require('./log');
const { deploy } = require('./deploy');
const remote = require('./remote');

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
    else if (a === '--force') options.force = true;
    else if (a === '--no-stash') options.stash = false;
  }
  return options;
}

const HELP = `deploy-kit — hook-driven deploy + remote PM2 ops

Usage: deploy-kit <command> [options]   (reads .deploy-kit.config.json from cwd)

Commands:
  deploy [--skip-build|--skip-deps|--skip-migrate|--no-stash]
  status | health | dashboard | resources | git
  start | stop | restart
  logs [--lines N] [--follow] [--errors]
  help`;

function run(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const command = argv[0];
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  const config = loadConfig({ cwd });
  const options = parseOptions(argv.slice(1));

  switch (command) {
    case 'deploy':
      try {
        deploy(config, options);
        return 0;
      } catch (error) {
        log.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
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
  process.exit(run());
}

module.exports = { run, parseOptions };

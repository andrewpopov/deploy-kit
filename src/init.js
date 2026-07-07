'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG_FILENAME } = require('./config');
const { log: defaultLog } = require('./log');

// A commented starter config. JSON has no comments, so the guidance is printed
// alongside; the written file is valid JSON a consumer edits in place.
const SKELETON = {
  host: 'youruser@your-tailscale-host',
  projectDir: '/srv/yourapp',
  mode: 'ssh',
  branch: null,
  appNames: ['yourapp-app'],
  dbBoundApps: ['yourapp-app'],
  tunnelName: null,
  ensureApps: [],
  port: 3000,
  healthPath: '/api/health',
  hooks: {
    install: 'npm ci --prefer-offline || npm ci || npm install',
    backup: 'npx db-backup backup --prod --allow-missing',
    migrate: 'npm run db:migrate:prod',
    build: 'npm run build',
  },
};

const SCRIPTS_BLOCK = `  "scripts": {
    "deploy": "deploy-kit deploy",
    "deploy:dry": "deploy-kit deploy --dry-run",
    "rollback": "deploy-kit rollback",
    "remote:status": "deploy-kit status",
    "remote:logs": "deploy-kit logs",
    "remote:restart": "deploy-kit restart"
  }`;

// Scaffold a new consumer: write a `.deploy-kit.config.json` skeleton (never
// overwriting an existing one) and print the recommended package.json scripts.
function init({ cwd = process.cwd(), fsImpl = fs, log = defaultLog } = {}) {
  const target = path.join(cwd, CONFIG_FILENAME);
  const existed = fsImpl.existsSync(target);
  if (existed) {
    log.warning(`${CONFIG_FILENAME} already exists — leaving it untouched.`);
  } else {
    fsImpl.writeFileSync(target, `${JSON.stringify(SKELETON, null, 2)}\n`);
    log.success(`Wrote ${CONFIG_FILENAME} — edit host/projectDir/appNames/hooks for your app.`);
  }
  log.info('Add these scripts to package.json:');
  log.info(`\n${SCRIPTS_BLOCK}\n`);
  log.info('Then: edit the config, run `deploy-kit deploy --dry-run`, then `deploy-kit deploy`.');
  return { configPath: target, wrote: !existed };
}

module.exports = { init, SKELETON, SCRIPTS_BLOCK };

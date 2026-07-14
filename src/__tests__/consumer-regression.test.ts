// Regression guard for the 7 real fleet consumers (BEWK/CAIRN/CLIPD/MIZEN/SANO/
// SAVORO/SMARTHOME). Loads each app's REAL .deploy-kit.config.json (embedded
// verbatim below — copied from the app repo at the time this test was written) and
// asserts the CURRENT kit emits the byte-identical command sequence that the
// actual v0.9.4 deploy.js/release.js emitted for that same config. `preRestartChecks`
// is absent from every one of these configs, so this is exactly the "strictly
// config-gated" claim: the new phase must be a config-invisible no-op for every
// existing consumer.
//
// The v0.9.4 source is loaded live from the git tag (not retyped/duplicated here)
// so this test can't silently drift from what v0.9.4 actually did.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import Module from 'module';

const require = createRequire(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const kit = require('../index.js') as typeof import('../index');
const { loadConfig } = kit;

// Load a source file AS IT WAS AT TAG `tag`, wired to the CURRENT (unchanged since
// v0.9.4) exec/lock/log modules, and to `overrides` for its other in-package
// requires (used to wire release.js's old deploy.js dependency, and deploy.js's
// old release.js dependency, so the pair is internally consistent).
function loadAtTag(relFile: string, tag: string, overrides: Record<string, unknown> = {}) {
  const source = execSync(`git show ${tag}:src/${relFile}`, { cwd: REPO_ROOT, encoding: 'utf8' });
  const filename = path.join(REPO_ROOT, 'src', relFile);
  const m = new Module(filename, module);
  m.filename = filename;
  (m as any).paths = (Module as any)._nodeModulePaths(path.dirname(filename));
  const nodeRequire = m.require.bind(m);
  (m as any).require = (id: string) => (id in overrides ? overrides[id] : nodeRequire(id));
  (m as any)._compile(source, filename);
  return m.exports;
}

const exec = require('../exec.js');
const lock = require('../lock.js');
const log = require('../log.js');

const TAG = 'v0.9.4';
const oldRelease = loadAtTag('release.js', TAG, { './exec': exec, './lock': lock, './log': log });
const oldDeploy = loadAtTag('deploy.js', TAG, {
  './exec': exec, './lock': lock, './log': log, './release': oldRelease,
});
// v0.9.4's release.js resolves the peer deploy.js via `require('./deploy')` only
// indirectly (it doesn't) — release.js has no back-reference to deploy.js, so no
// further wiring is needed here.

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// One universal fake execFileSync good enough to drive EITHER the legacy or the
// release pipeline for any of the 7 real configs without throwing on an
// unrecognized command (falls back to '' — this test cares about the COMMAND
// SEQUENCE the kit emits, not deep correctness of a specific hook's output).
function makeUniversalRuntime(appNames: string[]) {
  const calls: string[] = [];
  const stopped = new Set<string>();
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (/pm2 stop /.test(cmd)) { appNames.forEach((n) => stopped.add(n)); return ''; }
    if (/pm2 (startOrRestart|start|restart)/.test(cmd)) { stopped.clear(); return ''; }
    if (cmd.includes('.deploy-kit-layout')) return '{"layout":"releases","version":1}';
    if (cmd.includes('cat') && cmd.includes('deploy-kit-state.json')) return '';
    if (cmd.includes('mv --version')) return 'mv (GNU coreutils) 9.1';
    if (cmd.includes('df -kP') || cmd.includes('df -Pk')) return '99999999';
    if (cmd.includes('date -u')) return '20260710T090000Z';
    if (cmd.includes('rev-parse HEAD')) return SHA;
    if (cmd.includes('rev-parse')) return SHA;
    if (cmd.includes('readlink -f')) return '/canonical';
    if (cmd.includes('pm2 jlist')) {
      return JSON.stringify(appNames.map((n) => ({ name: n, pid: 111, pm2_env: { status: 'online', restart_time: 5 } })));
    }
    if (cmd.includes('readlink ') && cmd.includes('/current')) return 'releases/prev1234567-20260709T090000Z';
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return 'releases/prev0000000-20260708T090000Z';
    if (cmd.includes('ls -1')) return 'prev1234567-20260709T090000Z\nprev0000000-20260708T090000Z';
    if (cmd.includes('git ls-files')) return '';
    if (cmd.includes('curl')) return '200';
    if (/backup/i.test(cmd)) return '/var/lib/app/backups/backup-1.gpg'; // safe backupId shape
    return '';
  };
  return { execFileSync, calls };
}

const ctx = (runtime: unknown) => ({ runtime, sleep: () => {} });

// --- The 7 real consumer configs, embedded verbatim. ---
const CONFIGS: Record<string, unknown> = {
  bewks: {
    host: 'bewks@100.92.155.27', projectDir: '/srv/bewks', mode: 'ssh', branch: 'master',
    appNames: ['bewks-app'], dbBoundApps: ['bewks-app', 'bewks-goodreads-worker'],
    ensureApps: ['bewks-goodreads-worker', 'bewks-tunnel'], ecosystemFile: 'ecosystem.config.js',
    tunnelName: 'bewks-tunnel', port: 3000, healthPath: '/api/health',
    hooks: {
      install: 'npm ci || npm install', backup: 'npm run db:backup:prod',
      migrate: 'npm run db:migrate:prod && npm run smoke:user:prod:if-configured && npm run smoke:user:prod:admin:if-configured && npm run ensure:owner:if-configured',
      build: 'rm -rf .next/types && NODE_ENV=production BEWKS_ENV=prod npm run build',
    },
  },
  cairn: {
    host: 'cairn@bigpi', projectDir: '/srv/cairn', mode: 'ssh', branch: 'master',
    appNames: ['cairn-app'], dbBoundApps: ['cairn-app'], tunnelName: 'cairn-tunnel',
    ecosystemFile: 'shared/ecosystem.config.cjs', port: 3004, healthPath: '/api/health',
    layout: {
      type: 'releases', keepReleases: 4,
      sharedPaths: ['.env', 'packages/api/prisma/data', 'uploads'],
      releaseChecks: [{ name: 'prisma-client-loads', command: "node -e \"require('@prisma/client')\"" }],
      runningShaCommand: "curl -sf http://localhost:3004/api/health | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).deployment?.releaseId||''))\"",
    },
    postDeployChecks: [{
      name: 'production-board-smoke',
      command: 'cd current && set -a && . ./.env && set +a && E2E_PRODUCTION_SMOKE=1 E2E_BASE_URL=https://cairn.andrewvpopov.com npx playwright test --config packages/web-app/playwright.config.ts packages/web-app/e2e/production-board-smoke.spec.ts',
    }],
    deliveryEvent: { command: 'cd current && set -a && . ./.env && set +a && node scripts/emit-cairn-deployment-event.js' },
    hooks: {
      install: 'npm ci || npm install || exit 1; npx playwright install chromium',
      backup: 'bash scripts/backup-deploy.sh',
      migrate: 'DATABASE_URL="file:/srv/cairn/shared/data/cairn.db" npx prisma migrate deploy --schema packages/api/prisma/schema.prisma && chmod 600 /srv/cairn/shared/data/cairn.db /srv/cairn/shared/data/cairn.db-wal /srv/cairn/shared/data/cairn.db-shm 2>/dev/null || true',
      build: 'npm run build', restore: 'bash scripts/restore-deploy-backup.sh',
    },
  },
  clipd: {
    host: 'clipd@bigpi', projectDir: '/srv/clipd', mode: 'ssh', branch: 'main',
    appNames: ['clipd-api'], dbBoundApps: [], tunnelName: 'clipd-tunnel',
    ecosystemFile: 'ecosystem.config.cjs', port: 3004, healthPath: '/health',
    healthHeaders: { 'X-Forwarded-Proto': 'https' },
    hooks: { install: 'npm ci || npm install', build: 'npm run build' },
  },
  mizen: {
    host: 'mizen@bigpi', projectDir: '/srv/mizen', mode: 'ssh', branch: 'main',
    appNames: ['mizen-api', 'mizen-collaboration', 'mizen-worker'],
    dbBoundApps: ['mizen-api', 'mizen-collaboration', 'mizen-worker'],
    tunnelName: 'mizen-tunnel', ensureApps: ['mizen-tunnel'], ecosystemFile: 'ecosystem.config.cjs',
    port: 3012, healthPath: '/health/ready', stepTimeoutSeconds: 900,
    preDeployChecks: [{ name: 'disk', command: "test \"$(df -Pk /srv/mizen | awk 'NR==2{print $4}')\" -ge 1048576" }],
    hooks: {
      install: 'pnpm install --frozen-lockfile --prefer-offline', backup: 'bash scripts/deploy-backup.sh',
      migrate: 'set -a; . ./.env.production; set +a; DATABASE_URL="$MIGRATION_DATABASE_URL" pnpm db:migrate',
      build: 'pnpm build', restore: 'bash current/scripts/deploy-restore.sh',
    },
    layout: {
      type: 'releases', keepReleases: 4, sharedPaths: ['.env', '.env.production'],
      releaseChecks: [
        { name: 'api-entrypoint', command: 'test -f apps/api/dist/main.js' },
        { name: 'web-build', command: 'test -f apps/web/dist/index.html' },
        { name: 'collaboration-entrypoint', command: 'test -f apps/collaboration/dist/main.js' },
        { name: 'worker-entrypoint', command: 'test -f apps/worker/dist/main.js' },
      ],
    },
  },
  'sano-os': {
    mode: 'local', projectDir: '/srv/sano-os', branch: 'main', appNames: ['sano-app'],
    dbBoundApps: ['sano-app'], tunnelName: 'sano-tunnel', ensureApps: ['sano-tunnel'],
    ecosystemFile: 'ecosystem.config.cjs', buildBeforeMigrate: true,
    preDeployChecks: [
      { name: 'disk', command: "test \"$(df -Pk /srv/sano-os | awk 'NR==2{print $4}')\" -ge 512000" },
      { name: 'e2e', command: 'pnpm e2e:ci' },
    ],
    port: 3003, healthPath: '/api/health/ready',
    hooks: {
      install: 'pnpm install --frozen-lockfile', backup: 'npm run backup',
      migrate: 'pnpm --filter @sano/api db:migrate', build: 'pnpm build',
    },
  },
  savoro: {
    host: 'savoro@bigpi', projectDir: '/srv/savoro', mode: 'ssh', branch: 'master',
    appNames: ['savoro-api', 'savoro-web'], dbBoundApps: ['savoro-api'],
    tunnelName: 'pantry-tunnel', ensureApps: ['pantry-tunnel'], ecosystemFile: 'ecosystem.config.js',
    port: 3001, healthPath: '/api/health', healthHeaders: { 'X-Forwarded-Proto': 'https' },
    buildBeforeMigrate: true,
    hooks: {
      install: 'npm ci || npm install', backup: 'npm run backup',
      migrate: 'npm run db:deploy && npm run db:verify-drift', build: 'npm run db:generate && npm run build',
    },
  },
  smarthome: {
    host: 'smarthome@100.92.155.27', projectDir: '/srv/smarthome', mode: 'ssh', branch: 'master',
    appNames: ['smarthome-api', 'smarthome-web'], dbBoundApps: ['smarthome-api'],
    tunnelName: 'smarthome-tunnel', port: 3002, healthPath: '/health',
    ecosystemFile: 'shared/ecosystem.config.cjs',
    layout: {
      type: 'releases', keepReleases: 4, sharedPaths: ['.env', 'packages/api/prisma/data'],
      releaseChecks: [{ name: 'prisma-client-loads', command: "node -e \"require('@prisma/client')\"" }],
      runningShaCommand: "curl -sf localhost:3002/health | node -e \"let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).buildSha||''))\"",
    },
    hooks: {
      install: 'npm ci --include=dev || npm install', backup: 'bash scripts/backup-db.sh --local',
      migrate: 'DATABASE_URL="file:/srv/smarthome/shared/data/smarthome.db" npx prisma migrate deploy --schema packages/api/prisma/schema.prisma',
      build: 'npm run build', restore: 'bash scripts/restore-db.sh --deploy-hook',
    },
  },
};

function run(deployFn: Function, config: any, appNames: string[]) {
  const { execFileSync, calls } = makeUniversalRuntime(appNames);
  let error: any = null;
  let result: any = null;
  try {
    result = deployFn(config, {}, ctx({ execFileSync }));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { calls, result, error };
}

describe('consumer regression: v0.9.4 command sequence is byte-identical (preRestartChecks absent)', () => {
  for (const [name, raw] of Object.entries(CONFIGS)) {
    it(`${name}: deploy() emits the same command sequence as v0.9.4`, () => {
      const fsImpl = { existsSync: () => true, readFileSync: () => JSON.stringify(raw) };
      const config = loadConfig({ cwd: `/${name}`, fsImpl });
      const appNames = (config as any).appNames as string[];

      const oldRun = run(oldDeploy.deploy, config, appNames);
      const newRun = run(kit.deploy, config, appNames);

      expect(newRun.calls).toEqual(oldRun.calls);
      expect(newRun.error).toEqual(oldRun.error);
    });
  }
});

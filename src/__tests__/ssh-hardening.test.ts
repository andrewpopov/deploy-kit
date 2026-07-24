import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const kit = require('../index.js') as typeof import('../index');
const { sshHardeningArgs, buildTargetCommand, DEFAULT_CONFIG } = kit;

// PKG-82: host-key + batch-mode defaults, and validation of ssh.options shape.
//
// Note on defaults: `DEFAULT_CONFIG.ssh` (src/config.js) does not yet set
// `strictHostKeyChecking` / `batchMode` — that DEFAULT_CONFIG edit is out of
// scope for this change (config validation/defaults belong to another agent)
// and is called out separately. `sshHardeningArgs` already supports both keys
// with the same opt-out-via-null convention as connectTimeout etc., so these
// tests exercise the mechanism directly by passing the values a future
// DEFAULT_CONFIG would supply.
describe('ssh hardening: host-key + batch defaults', () => {
  it('includes StrictHostKeyChecking and BatchMode when set', () => {
    const args = sshHardeningArgs({ ...DEFAULT_CONFIG.ssh, strictHostKeyChecking: 'accept-new', batchMode: 'yes' });
    expect(args).toContain('-o');
    expect(args).toEqual(
      expect.arrayContaining(['StrictHostKeyChecking=accept-new', 'BatchMode=yes'])
    );
  });

  it('each default can be opted out via null', () => {
    const args = sshHardeningArgs({ ...DEFAULT_CONFIG.ssh, strictHostKeyChecking: null, batchMode: null });
    expect(args.join(' ')).not.toContain('StrictHostKeyChecking');
    expect(args.join(' ')).not.toContain('BatchMode');
  });

  it('omitting the keys entirely omits the flags too (no hidden hardcoded default)', () => {
    // Guards against silently reintroducing hardcoded defaults inside
    // sshHardeningArgs itself, which would break the frozen assertion in
    // deploy-kit.test.ts:409-412 (a raw ssh object with no strictHostKeyChecking/
    // batchMode keys must not gain surprise flags).
    const args = sshHardeningArgs({ connectTimeout: null, serverAliveInterval: 5, serverAliveCountMax: null, options: ['BatchMode=yes'] });
    expect(args).toEqual(['-o', 'ServerAliveInterval=5', '-o', 'BatchMode=yes']);
  });

  // THE ORDERING TEST: OpenSSH uses the FIRST `-o Key=Value` it sees for a given
  // key and ignores later duplicates (verified against `man ssh_config` on this
  // machine: "the first obtained value will be used"). So a user override in
  // ssh.options must land in argv BEFORE our default of the same key, or the
  // user's config would be silently ignored — exactly the bug this ticket exists
  // to close. This test fails loudly if that ordering is ever reversed.
  it('a user-supplied StrictHostKeyChecking in ssh.options wins over the default', () => {
    const args = sshHardeningArgs({
      ...DEFAULT_CONFIG.ssh,
      strictHostKeyChecking: 'accept-new',
      options: ['StrictHostKeyChecking=yes'],
    });
    const userIdx = args.indexOf('StrictHostKeyChecking=yes');
    const defaultIdx = args.indexOf('StrictHostKeyChecking=accept-new');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    // The default value must not even appear once the user has overridden it via
    // ssh.options... but our implementation still emits both -o flags (ssh
    // itself resolves the duplicate). What matters is ORDER: the user's flag
    // must come first so ssh actually honors it.
    expect(defaultIdx).toBeGreaterThan(userIdx);
  });

  it('a user-supplied BatchMode in ssh.options wins over the default (deploy-kit.test.ts:410 style)', () => {
    const args = sshHardeningArgs({
      ...DEFAULT_CONFIG.ssh,
      batchMode: 'yes',
      options: ['BatchMode=no'],
    });
    const userIdx = args.indexOf('BatchMode=no');
    const defaultIdx = args.indexOf('BatchMode=yes');
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(defaultIdx).toBeGreaterThan(userIdx);
  });

  it('buildTargetCommand still puts the host/remote command last with defaults set', () => {
    const { file, args } = buildTargetCommand('pm2 status', {
      mode: 'ssh',
      host: 'app@pi',
      projectDir: '/srv/app',
      ssh: { ...DEFAULT_CONFIG.ssh, strictHostKeyChecking: 'accept-new', batchMode: 'yes' },
    } as any);
    expect(file).toBe('ssh');
    expect(args[args.length - 2]).toBe('app@pi');
    expect(args[args.length - 1]).toBe('cd /srv/app && pm2 status');
    expect(args).toEqual(
      expect.arrayContaining(['-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'])
    );
  });
});

describe('ssh hardening: ssh.options shape validation', () => {
  it('rejects a malformed entry and names it in the error', () => {
    expect(() => sshHardeningArgs({ options: ['not-a-valid-option'] })).toThrow(/not-a-valid-option/);
  });

  it('rejects a non-string entry and names it in the error', () => {
    expect(() => sshHardeningArgs({ options: [{ ProxyCommand: 'evil' }] })).toThrow(/ssh\.options entry/);
  });

  it('rejects an entry missing "=" ', () => {
    expect(() => sshHardeningArgs({ options: ['BatchMode'] })).toThrow(/ssh\.options entry/);
  });

  it('accepts a well-formed Key=Value entry, including ProxyCommand as a legitimate escape hatch', () => {
    const args = sshHardeningArgs({ options: ['ProxyCommand=ssh -W %h:%p bastion'] });
    expect(args).toEqual(['-o', 'ProxyCommand=ssh -W %h:%p bastion']);
  });

  it('still accepts the existing BatchMode=yes injection used at deploy-kit.test.ts:410', () => {
    const args = sshHardeningArgs({ connectTimeout: null, serverAliveInterval: 5, serverAliveCountMax: null, options: ['BatchMode=yes'] });
    expect(args).toEqual(['-o', 'ServerAliveInterval=5', '-o', 'BatchMode=yes']);
  });
});

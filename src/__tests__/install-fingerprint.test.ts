import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { deploy, rollback, mergeConfig, DEFAULT_CONFIG } = require('../index.js') as typeof import('../index');
const { fingerprintCommand, parseFingerprint, MARKER } = require('../install-fingerprint.js');
const { validateConfig } = require('../config.js');

const SHA = 'a'.repeat(40);
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const CANDIDATE = '/srv/app/releases/a1b2c3d4e5f6-20260710T090000Z';

// A target that remembers node_modules markers per directory. `fingerprints` maps a directory to what the fingerprint
// script prints there; `installFails` makes the install command exit non-zero.
function target(over: { fingerprints?: Record<string, string>; markers?: Record<string, string>; installFails?: boolean; nodeModules?: boolean } = {}) {
  const fingerprints = over.fingerprints || { '/srv/app': FP_A, [CANDIDATE]: FP_A };
  const markers: Record<string, string> = { ...(over.markers || {}) };
  const calls: string[] = [];
  const dirOf = (cmd: string) => /^cd '?([^' ]+)'? && /.exec(cmd)?.[1] || '';
  const fail = () => { throw Object.assign(new Error('fake failure'), { status: 1, stdout: '' }); };
  const execFileSync = (_file: string, args: string[]) => {
    const full = args[args.length - 1];
    const dir = dirOf(full);
    const cmd = full.replace(/^cd '?[^' ]+'? && /, '');
    calls.push(full);
    if (cmd.includes('process.version')) return `${fingerprints[dir] ?? ''}\n`;
    if (cmd.startsWith('[ -d node_modules ]')) return over.nodeModules === false ? '' : `${markers[dir] ?? ''}\n`;
    if (cmd === `rm -f ${MARKER}`) { delete markers[dir]; return ''; }
    if (cmd.startsWith("printf '%s\\n' '")) { markers[dir] = /'([0-9a-f]{64})'/.exec(cmd)![1]; return ''; }
    if (cmd.startsWith('cp -a --reflink=auto')) { markers[dir] = markers[/'([^']+)\/node_modules'/.exec(cmd)![1]]; return ''; }
    if (cmd === 'npm ci' || cmd.endsWith(' npm ci')) { if (over.installFails) fail(); return ''; }
    if (cmd.includes('curl')) return '200';
    if (cmd.includes('git symbolic-ref')) return 'master';
    if (cmd.includes('git rev-parse')) return SHA;
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 1, pm2_env: { status: 'online' } }]);
    if (cmd.includes('prev-sha')) return SHA;
    return '';
  };
  const installs = () => calls.filter((c) => /(^| )npm ci$/.test(c));
  return { runtime: { execFileSync }, calls, markers, installs };
}

const legacy = (over: Record<string, unknown> = {}) => mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], branch: 'master', autoCut: false,
  hooks: { install: 'npm ci', backup: 'b', migrate: 'm', build: 'npm run build' },
  ...over,
});

function harness() {
  let t = 0;
  const lines: string[] = [];
  const marks: Array<{ step: string; note?: string }> = [];
  const log = {
    info: (m: string) => lines.push(m), success: () => {}, warning: (m: string) => lines.push(m), error: () => {}, header: () => {}, divider: () => {},
    step: (m: string) => lines.push(`▸ ${m}`),
  };
  const ctx = (runtime: unknown) => ({ runtime, sleep: () => {}, log, clock: () => (t += 1000), onStep: (e: { step: string; note?: string }) => marks.push(e) });
  return { lines, marks, ctx };
}

describe('legacy layout install fingerprint (PKG-315)', () => {
  it('skips the install when the recorded fingerprint equals the new one, still runs verify-pins, and shows it in the timing table', () => {
    const t = target({ markers: { '/srv/app': FP_A } });
    const h = harness();
    deploy(legacy(), { sha: SHA }, h.ctx(t.runtime));
    expect(t.installs()).toHaveLength(0);
    expect(h.lines.some((l) => /Skipping install/.test(l))).toBe(true);
    expect(h.lines.some((l) => /^ {2}install\s+\d+\.\ds \(unchanged\)$/.test(l))).toBe(true);
    expect(h.marks.map((m) => m.step)).toContain('verify-pins');
  });

  it('installs and records the fingerprint when nothing is recorded', () => {
    const t = target();
    deploy(legacy(), { sha: SHA }, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
    expect(t.markers['/srv/app']).toBe(FP_A);
  });

  it('installs when the lockfile or node version changed (the fingerprint differs from the recorded one)', () => {
    const t = target({ markers: { '/srv/app': FP_B } });
    deploy(legacy(), { sha: SHA }, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
    expect(t.markers['/srv/app']).toBe(FP_A);
  });

  it('installs when node_modules is missing, whatever marker remains', () => {
    const t = target({ markers: { '/srv/app': FP_A }, nodeModules: false });
    deploy(legacy(), { sha: SHA }, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
  });

  it('a failed install clears the marker and records nothing, so the next deploy installs', () => {
    const failing = target({ markers: { '/srv/app': FP_B }, installFails: true });
    expect(() => deploy(legacy(), { sha: SHA }, harness().ctx(failing.runtime))).toThrow(/Installing dependencies failed/);
    expect(failing.markers['/srv/app']).toBeUndefined();
    const next = target({ markers: failing.markers });
    deploy(legacy(), { sha: SHA }, harness().ctx(next.runtime));
    expect(next.installs()).toHaveLength(1);
  });

  it('skipUnchangedInstall: false installs every time and records no fingerprint', () => {
    const t = target({ markers: { '/srv/app': FP_A } });
    deploy(legacy({ skipUnchangedInstall: false }), { sha: SHA }, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
    expect(t.markers['/srv/app']).toBeUndefined();
  });

  it('--force-install installs although the fingerprint matches, then records it', () => {
    const t = target({ markers: { '/srv/app': FP_A } });
    deploy(legacy(), { sha: SHA, forceInstall: true }, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
    expect(t.markers['/srv/app']).toBe(FP_A);
  });

  it('an unreadable fingerprint (no node, no hasher) never skips', () => {
    const t = target({ fingerprints: {}, markers: { '/srv/app': FP_A } });
    deploy(legacy(), { sha: SHA }, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
  });

  it('rollback reinstalls through the same marker, so a rolled-back tree cannot be mistaken for the newer one', () => {
    const t = target({ markers: { '/srv/app': FP_B } });
    rollback(legacy(), {}, harness().ctx(t.runtime));
    expect(t.installs()).toHaveLength(1);
    expect(t.markers['/srv/app']).toBe(FP_A);
  });
});

describe('fingerprint command', () => {
  const cmd = fingerprintCommand(legacy({ installFingerprintFiles: ['packages/*/package.json'] }));
  it('hashes lockfiles, extra files, node, the package managers and the install command', () => {
    expect(cmd).toContain('package-lock.json');
    expect(cmd).toContain('packages/*/package.json');
    expect(cmd).toContain('process.version');
    expect(cmd).toContain('uname -sm');
    expect(cmd).toContain("'npm ci'");
  });
  it('parses only a 64-hex last line', () => {
    expect(parseFingerprint(`warn\n${FP_A}\n`)).toBe(FP_A);
    expect(parseFingerprint('')).toBeNull();
    expect(parseFingerprint('not a hash')).toBeNull();
  });
  it('rejects fingerprint files that could escape or inject', () => {
    for (const bad of ['../x', '/etc/passwd', 'a; rm -rf /', 'a b']) {
      expect(validateConfig({ installFingerprintFiles: [bad] }).join()).toMatch(/installFingerprintFiles\[0\]/);
    }
    expect(validateConfig({ installFingerprintFiles: ['packages/*/package.json'], skipUnchangedInstall: false })).toEqual([]);
  });
});

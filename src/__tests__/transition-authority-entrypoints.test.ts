import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { assertTransitionAuthorityEntryPoint } = require('../transition-authority.js');
const { deploy, rollback } = require('../deploy.js');
const { deployRelease, rollbackRelease } = require('../release.js');
const remote = require('../remote.js');

type Json = Record<string, unknown>;
const AUTHORITY = { command: 'authority-cli --record', scope: 'app-prod' };
const config = (extra: Json = {}): Json => ({
  mode: 'local', appNames: ['app'], transitionAuthority: AUTHORITY, ...extra,
});
const releases = { layout: { type: 'releases' } };

function host() {
  const calls: unknown[][] = [];
  const execFileSync = (...args: unknown[]): string => { calls.push(args); throw new Error('target called'); };
  return { calls, ctx: { runtime: { execFileSync } } };
}
function codeOf(fn: () => unknown): string {
  try { fn(); } catch (error) {
    return error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'NO_CODE';
  }
  return 'NO_THROW';
}
const UNSUPPORTED = 'TRANSITION_AUTHORITY_UNSUPPORTED';
const OPTIONS = 'TRANSITION_AUTHORITY_OPTIONS_INVALID';

describe('assertTransitionAuthorityEntryPoint', () => {
  it('allows unconfigured config and safe supported options', () => {
    expect(codeOf(() => assertTransitionAuthorityEntryPoint({ mode: 'local' }))).toBe('NO_THROW');
    expect(codeOf(() => assertTransitionAuthorityEntryPoint({ transitionAuthority: null }))).toBe('NO_THROW');
    expect(codeOf(() => assertTransitionAuthorityEntryPoint(config(), { supported: true, options: {} }))).toBe('NO_THROW');
  });
  it('denies configured unsupported entries, including malformed values', () => {
    for (const value of [AUTHORITY, false, {}, 0, '']) {
      expect(codeOf(() => assertTransitionAuthorityEntryPoint(config({ transitionAuthority: value })))).toBe(UNSUPPORTED);
    }
  });
  it('denies unsafe lock settings on supported entries', () => {
    expect(codeOf(() => assertTransitionAuthorityEntryPoint(config({ lock: false }), { supported: true }))).toBe(OPTIONS);
    for (const stealLock of [true, 1, 'yes']) {
      expect(codeOf(() => assertTransitionAuthorityEntryPoint(config(), { supported: true, options: { stealLock } }))).toBe(OPTIONS);
    }
  });
});

describe('entrypoint guards touch no target', () => {
  it('rejects legacy deploy and rollback', () => {
    const { calls, ctx } = host();
    expect(codeOf(() => deploy(config(), {}, ctx))).toBe(UNSUPPORTED);
    expect(codeOf(() => rollback(config(), {}, ctx))).toBe(UNSUPPORTED);
    expect(calls).toHaveLength(0);
  });
  it('rejects a malformed false authority on the legacy path', () => {
    const { calls, ctx } = host();
    expect(codeOf(() => deploy(config({ transitionAuthority: false }), {}, ctx))).toBe(UNSUPPORTED);
    expect(codeOf(() => rollback(config({ transitionAuthority: false }), {}, ctx))).toBe(UNSUPPORTED);
    expect(calls).toHaveLength(0);
  });
  it('rejects remote lifecycle verbs, even on the release layout', () => {
    const { calls, ctx } = host();
    for (const verb of [remote.start, remote.stop, remote.restart]) {
      expect(codeOf(() => verb(config(), ctx))).toBe(UNSUPPORTED);
      expect(codeOf(() => verb(config(releases), ctx))).toBe(UNSUPPORTED);
    }
    expect(calls).toHaveLength(0);
  });
  it('rejects unsafe lock options on direct release entrypoints', () => {
    const { calls, ctx } = host();
    expect(codeOf(() => deployRelease(config(releases), { stealLock: true }, ctx))).toBe(OPTIONS);
    expect(codeOf(() => rollbackRelease(config(releases), { stealLock: true }, ctx))).toBe(OPTIONS);
    expect(codeOf(() => deployRelease(config({ ...releases, lock: false }), {}, ctx))).toBe(OPTIONS);
    expect(codeOf(() => rollbackRelease(config({ ...releases, lock: false }), {}, ctx))).toBe(OPTIONS);
    expect(calls).toHaveLength(0);
  });
  it('rejects unsafe lock options through generic deploy and rollback delegation', () => {
    const { calls, ctx } = host();
    expect(codeOf(() => deploy(config(releases), { stealLock: true }, ctx))).toBe(OPTIONS);
    expect(codeOf(() => rollback(config(releases), { stealLock: true }, ctx))).toBe(OPTIONS);
    expect(codeOf(() => deploy(config({ ...releases, lock: false }), {}, ctx))).toBe(OPTIONS);
    expect(codeOf(() => rollback(config({ ...releases, lock: false }), {}, ctx))).toBe(OPTIONS);
    expect(calls).toHaveLength(0);
  });
  it('leaves read-only status available with authority configured', () => {
    const { calls, ctx } = host();
    expect(() => remote.status(config(), { ...ctx, log: { header: () => undefined } })).not.toThrow();
    expect(calls.length).toBeGreaterThan(0);
  });
});

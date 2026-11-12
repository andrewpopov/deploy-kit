import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { deploy, mergeConfig, DEFAULT_CONFIG } = require('../index.js') as typeof import('../index');
const releaseModule = require('../release.js') as { deployRelease: (...args: unknown[]) => unknown };

const SHA = 'a'.repeat(40);

function fakeRuntime({ failOn = null as string | null, dryRun = false } = {}) {
  const calls: string[] = [];
  const online = new Set(['app']);
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    calls.push(cmd);
    if (failOn && cmd.endsWith(` && ${failOn}`)) throw Object.assign(new Error('fake failure'), { status: 1, stdout: '' });
    if (cmd.includes('curl')) return '200';
    if (cmd.includes('prev-sha') && cmd.includes('git rev-parse HEAD >')) return '';
    if (cmd.includes('prev-sha')) return SHA;
    if (cmd.includes('git symbolic-ref')) return 'master';
    if (cmd.includes('git rev-parse')) return SHA;
    if (/pm2 stop /.test(cmd)) { online.clear(); return ''; }
    if (/pm2 (start|restart)/.test(cmd)) { online.add('app'); return ''; }
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 1, pm2_env: { status: online.has('app') ? 'online' : 'stopped' } }]);
    return '';
  };
  return { runtime: { execFileSync, dryRun }, calls };
}

const everyStep = mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi',
  projectDir: '/srv/app',
  appNames: ['app'],
  dbBoundApps: ['app'],
  branch: 'master',
  autoCut: false,
  hooks: { install: 'npm ci', generate: 'npm run gen', backup: 'b', migrate: 'm', build: 'npm run build' },
  preDeployChecks: [{ name: 'disk', command: 'true' }],
  preMigrationChecks: [{ name: 'db', command: 'true' }],
  preRestartChecks: [{ name: 'smoke', command: 'true' }],
  postDeployChecks: [{ name: 'e2e', command: 'true' }],
});
const plain = mergeConfig(DEFAULT_CONFIG, {
  host: 'app@pi', projectDir: '/srv/app', appNames: ['app'], dbBoundApps: ['app'], branch: 'master', autoCut: false,
  hooks: { install: 'npm ci', backup: 'b', migrate: 'm', build: 'npm run build' },
});

function harness() {
  let t = 0;
  const marks: string[] = [];
  const lines: string[] = [];
  const log = {
    info: (m: string) => lines.push(m), success: () => {}, warning: () => {}, error: () => {}, header: () => {}, divider: () => {},
    step: (m: string) => lines.push(`▸ ${m}`),
  };
  const ctx = (runtime: unknown, extra: Record<string, unknown> = {}) => ({
    runtime, sleep: () => {}, log, clock: () => (t += 1000), onStep: (e: { step: string }) => marks.push(e.step), ...extra,
  });
  return { marks, lines, ctx };
}

describe('legacy deploy step marks (PKG-313)', () => {
  it('emits a mark for every step a legacy deploy runs', () => {
    const h = harness();
    deploy(everyStep, {}, h.ctx(fakeRuntime().runtime));
    expect(h.marks).toEqual([
      'preDeployChecks', 'stash', 'fetch', 'merge', 'install', 'generate', 'verify-pins', 'preMigrationChecks', 'stop-writers',
      'backup', 'migrate', 'build', 'preRestartChecks', 'pm2-restart', 'health', 'postDeployChecks',
    ]);
  });

  it('marks fetch then merge on the --sha path', () => {
    const h = harness();
    deploy(plain, { sha: SHA }, h.ctx(fakeRuntime().runtime));
    expect(h.marks.slice(0, 4)).toEqual(['stash', 'fetch', 'merge', 'install']);
  });

  it('marks build before stop-writers with buildBeforeMigrate', () => {
    const h = harness();
    deploy(plain, { buildBeforeMigrate: true }, h.ctx(fakeRuntime().runtime));
    expect(h.marks.indexOf('build')).toBeLessThan(h.marks.indexOf('stop-writers'));
    expect(h.marks.filter((m) => m === 'build')).toHaveLength(1);
  });

  it('suffixes every step line with elapsed seconds and prints the timing table with the downtime window', () => {
    const h = harness();
    deploy(everyStep, {}, h.ctx(fakeRuntime().runtime));
    const stepLines = h.lines.filter((l) => l.startsWith('▸'));
    expect(stepLines.length).toBeGreaterThan(5);
    for (const line of stepLines) expect(line).toMatch(/ \[\+\d+\.\ds\]$/);
    const table = h.lines.slice(h.lines.indexOf('deploy timing:'));
    expect(table.some((l) => /^ {2}stop-writers\s+\d+\.\ds$/.test(l))).toBe(true);
    expect(table.some((l) => /^ {2}total\s+\d+\.\ds$/.test(l))).toBe(true);
    expect(table.some((l) => /downtime window\s+\d+\.\ds \(stop-writers -> health done\)/.test(l))).toBe(true);
  });

  it('ends the downtime window at health, not at a later failing postDeployChecks', () => {
    const h2 = harness();
    const rt = fakeRuntime();
    const failingPost = mergeConfig(plain, { postDeployChecks: [{ name: 'e2e', command: 'post-fails' }] });
    const failing = { execFileSync: (f: string, a: string[]) => (a[a.length - 1].endsWith('&& post-fails') ? (() => { throw Object.assign(new Error('x'), { status: 1, stdout: '' }); })() : rt.runtime.execFileSync(f, a)) };
    expect(() => deploy(failingPost, {}, h2.ctx(failing))).toThrow(/Post-deploy check/);
    expect(h2.lines.some((l) => /downtime window\s+\d+\.\ds \(stop-writers -> health done\)/.test(l))).toBe(true);
  });

  it('prints the timing table when the deploy fails and resumes the paused writers', () => {
    const h = harness();
    const { runtime, calls } = fakeRuntime({ failOn: 'm' });
    expect(() => deploy(plain, {}, h.ctx(runtime))).toThrow(/migrations failed/);
    expect(h.marks.slice(-2)).toEqual(['migrate', 'resume-writers']);
    expect(calls.some((c) => c.includes('pm2 start app'))).toBe(true);
    expect(h.lines).toContain('deploy timing:');
    expect(h.lines.some((l) => /\(stop-writers -> resume-writers\)/.test(l))).toBe(true);
  });

  it('a throwing onStep during the pause still resumes the paused apps and keeps the original error', () => {
    const h = harness();
    const { runtime, calls } = fakeRuntime({ failOn: 'm' });
    const throwing = h.ctx(runtime, { onStep: () => { throw new Error('telemetry exploded'); } });
    expect(() => deploy(plain, {}, throwing)).toThrow(/migrations failed/);
    expect(calls.some((c) => c.includes('pm2 start app'))).toBe(true);
  });

  it('does not stamp stop-writers when the pre-pause pm2 read fails', () => {
    const h = harness();
    const { runtime } = fakeRuntime();
    const unreadable = { execFileSync: (f: string, a: string[]) => (a[a.length - 1].includes('pm2 jlist') ? 'not json' : runtime.execFileSync(f, a)) };
    expect(() => deploy(plain, {}, h.ctx(unreadable))).toThrow(/could not determine/);
    expect(h.marks).not.toContain('stop-writers');
  });

  it('prints no timing table on a dry run', () => {
    const h = harness();
    deploy(plain, {}, h.ctx(fakeRuntime({ dryRun: true }).runtime));
    expect(h.lines).not.toContain('deploy timing:');
  });

  it('gives the releases pipeline the step suffix and the table', () => {
    const h = harness();
    const spy = vi.spyOn(releaseModule, 'deployRelease').mockImplementation((_c, _o, ctx: any) => {
      ctx.onStep({ step: 'stop-writers', class: 'live' });
      ctx.log.step('Stopping');
      ctx.onStep({ step: 'pm2-restart', class: 'live' });
      ctx.log.step('Restarting');
      return {};
    });
    try {
      deploy({ ...plain, layout: { type: 'releases' } }, {}, h.ctx(fakeRuntime().runtime));
    } finally {
      spy.mockRestore();
    }
    expect(h.lines.filter((l) => l.startsWith('▸')).every((l) => / \[\+\d+\.\ds\]$/.test(l))).toBe(true);
    expect(h.lines).toContain('deploy timing:');
    expect(h.lines.some((l) => /\(stop-writers -> pm2-restart done\)/.test(l))).toBe(true);
  });
});

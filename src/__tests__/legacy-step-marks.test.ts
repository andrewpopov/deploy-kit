import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { deploy, mergeConfig, DEFAULT_CONFIG } = require('../index.js') as typeof import('../index');

const SHA = 'a'.repeat(40);

function fakeRuntime() {
  const execFileSync = (_file: string, args: string[]) => {
    const cmd = args[args.length - 1];
    if (cmd.includes('curl')) return '200';
    if (cmd.includes('prev-sha') && cmd.includes('git rev-parse HEAD >')) return '';
    if (cmd.includes('prev-sha')) return SHA;
    if (cmd.endsWith('git rev-parse HEAD')) return SHA;
    if (cmd.includes('pm2 jlist')) return JSON.stringify([{ name: 'app', pid: 1, pm2_env: { status: 'stopped' } }]);
    return '';
  };
  return { execFileSync };
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

function walk(config: typeof everyStep, ticks: () => number) {
  const marks: string[] = [];
  const lines: string[] = [];
  const log = {
    info: (m: string) => lines.push(m), success: () => {}, warning: () => {}, error: () => {}, header: () => {}, divider: () => {},
    step: (m: string) => lines.push(`▸ ${m}`),
  };
  const result = deploy(config, {}, {
    runtime: fakeRuntime(), sleep: () => {}, log, clock: ticks, onStep: (e: { step: string }) => marks.push(e.step),
  });
  return { marks, lines, result };
}

describe('legacy deploy step marks (PKG-313)', () => {
  it('emits a mark for every step a legacy deploy runs', () => {
    let t = 0;
    const { marks } = walk(everyStep, () => (t += 1000));
    expect(marks).toEqual([
      'preDeployChecks', 'fetch', 'merge', 'install', 'generate', 'verify-pins', 'preMigrationChecks', 'stop-writers',
      'backup', 'migrate', 'build', 'preRestartChecks', 'pm2-restart', 'health', 'postDeployChecks',
    ]);
  });

  it('suffixes every step line with elapsed seconds and prints the timing table with the downtime window', () => {
    let t = 0;
    const { lines } = walk(everyStep, () => (t += 1000));
    const stepLines = lines.filter((l) => l.startsWith('▸'));
    expect(stepLines.length).toBeGreaterThan(5);
    for (const line of stepLines) expect(line).toMatch(/ \[\+\d+\.\ds\]$/);
    const table = lines.slice(lines.indexOf('deploy timing:'));
    expect(table.some((l) => /^ {2}stop-writers\s+\d+\.\ds$/.test(l))).toBe(true);
    expect(table.some((l) => /^ {2}total\s+\d+\.\ds$/.test(l))).toBe(true);
    expect(table.some((l) => /downtime window\s+\d+\.\ds \(stop-writers -> health done\)/.test(l))).toBe(true);
    console.log(table.join('\n'));
  });

  it('still prints the timing table when the deploy fails', () => {
    const lines: string[] = [];
    const log = {
      info: (m: string) => lines.push(m), success: () => {}, warning: () => {}, error: () => {}, header: () => {}, divider: () => {}, step: () => {},
    };
    const runtime = { execFileSync: (f: string, a: string[]) => { if (a[a.length - 1].endsWith(' && m')) throw Object.assign(new Error('x'), { status: 1, stdout: '' }); return fakeRuntime().execFileSync(f, a); } };
    expect(() => deploy(everyStep, {}, { runtime, sleep: () => {}, log })).toThrow(/migrations failed/);
    expect(lines).toContain('deploy timing:');
    expect(lines.some((l) => /deploy ended \(failed\)/.test(l))).toBe(true);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const portGuard = require('../port-guard.js') as typeof import('../port-guard');
const { checkPortGuard } = portGuard;
const { run } = require('../cli.js') as { run: (argv: string[]) => number };
// cli.js does `const { log } = require('./log')` — the SAME singleton object we grab
// here, so spying on its methods captures exactly what the CLI emits (no fragile
// console/stdout interception, which vitest itself hijacks).
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

// Capture everything the CLI writes so we can assert WHICH code path produced an
// error. The load-bearing distinction: the port-guard HANDLER says "Invalid <port>"
// / "Usage: deploy-kit port-guard", whereas the generic parseOptions() flag validator
// says "Valid options: --lines, ...". If a positional <port> reaches parseOptions,
// the subcommand was dispatched in the wrong order (the real-deploy bug this guards).
function captureCli(argv: string[]): { code: number; out: string } {
  let out = '';
  const sink = (m: string): void => { out += String(m) + '\n'; };
  const spies = ['error', 'success', 'info', 'step', 'header', 'warn'].map((m) =>
    log[m] ? vi.spyOn(log, m).mockImplementation(sink) : null,
  );
  try {
    const code = run(argv);
    return { code, out };
  } finally {
    for (const s of spies) s?.mockRestore();
  }
}

describe('CLI: port-guard subcommand arg parsing (regression: caught only in a real deploy)', () => {
  it('a positional <port> reaches the port-guard handler, NOT parseOptions', () => {
    // Before the fix, `port-guard notaport app` hit parseOptions first and errored
    // "Unknown argument: notaport / Valid options: --lines, ...". After, the handler
    // owns it and reports "Invalid <port>".
    const { code, out } = captureCli(['port-guard', 'notaport', 'app']);
    expect(code).toBe(1);
    expect(out).toMatch(/Invalid <port>/);
    expect(out).not.toMatch(/Valid options: --lines/); // parseOptions must NOT have run
  });

  it('a valid-looking numeric <port> is not rejected as an unknown flag', () => {
    // The exact failed command from the towerpower deploy. On CI the port is free so
    // checkPortGuard returns ok; the point is it must PARSE, never "Unknown argument: 3006".
    const { out } = captureCli(['port-guard', '3006', 'some-app']);
    expect(out).not.toMatch(/Unknown argument: 3006/);
  });

  it('still rejects a stray flag from within the handler', () => {
    const { code, out } = captureCli(['port-guard', '--nope']);
    expect(code).toBe(1);
    expect(out).toMatch(/deploy-kit port-guard <port>/); // handler usage, not parseOptions
  });
});

// A fake execFileSync modeling `command -v`, lsof/ss, `pm2 pid`, and pgrep/ps
// process-tree walks. `has` controls which binaries "exist" on the fake host.
function makeRuntime({
  has = { lsof: true, ss: true, pgrep: true },
  listening = [] as string[],
  pm2Pids = [] as string[],
  children = {} as Record<string, string[]>, // pid -> direct children
} = {}) {
  const calls: string[] = [];
  const execFileSync = (file: string, args: string[]) => {
    calls.push([file, ...args].join(' '));
    if (file === 'sh' && args[0] === '-c' && args[1].startsWith('command -v ')) {
      const bin = args[1].replace('command -v ', '');
      if (!(has as any)[bin]) throw new Error('not found');
      return '';
    }
    if (file === 'lsof') return listening.join('\n');
    if (file === 'ss') return listening.map((p) => `LISTEN 0 128 *:3006 *:*  users:(("app",pid=${p},fd=3))`).join('\n');
    if (file === 'pm2' && args[0] === 'pid') return pm2Pids.join(' ');
    if (file === 'pgrep' && args[0] === '-P') {
      const parent = args[1];
      return (children[parent] || []).join('\n');
    }
    if (file === 'ps' && args.includes('--ppid')) {
      const parent = args[args.length - 1];
      return (children[parent] || []).join('\n');
    }
    return '';
  };
  return { runtime: { execFileSync }, calls };
}

describe('checkPortGuard', () => {
  it('passes when the port is free', () => {
    const { runtime } = makeRuntime({ listening: [] });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/free/);
  });

  it('passes when the only listener is the named pm2 process itself', () => {
    const { runtime } = makeRuntime({ listening: ['100'], pm2Pids: ['100'] });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/safe/);
  });

  it('passes when the listener is a DESCENDANT of the pm2 process (BFS via pgrep -P)', () => {
    const { runtime } = makeRuntime({
      listening: ['300'],
      pm2Pids: ['100'],
      children: { 100: ['200'], 200: ['300'] },
    });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(true);
  });

  it('fails BY NAME when a foreign process holds the port', () => {
    const { runtime } = makeRuntime({ listening: ['999'], pm2Pids: ['100'], children: { 100: ['200'] } });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('999');
    expect(result.message).toMatch(/towerpower-app/);
  });

  it('fails if ANY of several listeners is foreign, even if others are ours', () => {
    const { runtime } = makeRuntime({ listening: ['100', '777'], pm2Pids: ['100'] });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('777');
    expect(result.message).not.toContain('100,');
  });

  it('falls back to ss when lsof is absent', () => {
    const { runtime, calls } = makeRuntime({ has: { lsof: false, ss: true, pgrep: true }, listening: ['100'], pm2Pids: ['100'] });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('ss '))).toBe(true);
    expect(calls.some((c) => c.startsWith('lsof '))).toBe(false);
  });

  it('falls back to ps --ppid when pgrep is absent', () => {
    const { runtime, calls } = makeRuntime({
      has: { lsof: true, ss: true, pgrep: false },
      listening: ['300'],
      pm2Pids: ['100'],
      children: { 100: ['300'] },
    });
    const result = checkPortGuard(3006, 'towerpower-app', { runtime });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c.includes('--ppid'))).toBe(true);
  });

  it('FAILS CLOSED (loud) when neither lsof nor ss is available', () => {
    const warnings: string[] = [];
    const { runtime } = makeRuntime({ has: { lsof: false, ss: false, pgrep: true }, listening: [] });
    const log = { warning: (m: string) => warnings.push(m) };
    const result = checkPortGuard(3006, 'towerpower-app', { runtime, log: log as any });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/[Nn]either lsof nor ss/);
    expect(warnings.join('\n')).toMatch(/[Nn]either lsof nor ss/);
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const require = createRequire(__filename);
const { createDeployRecorder } = require('../deploy-history.js') as { createDeployRecorder: (o: any) => { onStep: (e: any) => void; finish: (r: any) => void } };
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number };
const deployOps = require('../deploy.js') as Record<string, (...a: any[]) => any>;
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const CONFIG = { host: 'deploy@example.test', projectDir: '/srv/my app' };
const tmps: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-history-')); tmps.push(d); return d; };
const historyDir = (home: string) => path.join(home, '.cache', 'deploy-kit');
const historyFile = (home: string) => path.join(historyDir(home), 'history.jsonl');
const lines = (home: string) => fs.readFileSync(historyFile(home), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function fakeClocks() {
  let wall = Date.parse('2026-10-28T10:00:00.000Z');
  let mono = 1000;
  return { now: () => wall, clock: () => mono, tick: (ms: number) => { wall += ms; mono += ms; } };
}

afterEach(() => {
  vi.restoreAllMocks();
  while (tmps.length) fs.rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('createDeployRecorder', () => {
  it('produces the exact record with marks in order', () => {
    const home = tmp();
    const c = fakeClocks();
    const rec = createDeployRecorder({ operation: 'deploy', config: CONFIG, home, now: c.now, clock: c.clock });
    c.tick(10); rec.onStep({ step: 'build', class: 'staging' });
    c.tick(90); rec.onStep({ step: 'flip', class: 'live' });
    c.tick(400);
    rec.finish({ result: 'ok', sha: SHA });
    const [row] = lines(home);
    expect(row).toEqual({
      version: 1, operation: 'deploy', service: row.service, sha: SHA, result: 'ok',
      startedAt: '2026-10-28T10:00:00.000Z', endedAt: '2026-10-28T10:00:00.500Z', durationMs: 500,
      marks: [{ step: 'build', class: 'staging', atMs: 10 }, { step: 'flip', class: 'live', atMs: 100 }],
    });
    expect(row.service).toMatch(/^my-app-[0-9a-f]{8}$/);
  });

  it('gives different projects different service ids', () => {
    const home = tmp();
    for (const cfg of [CONFIG, { ...CONFIG, host: 'other@example.test' }]) createDeployRecorder({ operation: 'deploy', config: cfg, home }).finish({ result: 'ok', sha: null });
    const [a, b] = lines(home);
    expect(a.service).not.toBe(b.service);
  });

  it('turns unsafe step text into other and a bad sha into null', () => {
    const home = tmp();
    const c = fakeClocks();
    const rec = createDeployRecorder({ operation: 'rollback', config: CONFIG, home, now: c.now, clock: c.clock });
    rec.onStep({ step: 'rm -rf /; echo $SECRET', class: { x: 1 } });
    rec.onStep(undefined);
    rec.finish({ result: 'failed', sha: 'nope' });
    const [row] = lines(home);
    expect(row.marks).toEqual([{ step: 'other', class: 'other', atMs: 0 }, { step: 'other', class: 'other', atMs: 0 }]);
    expect(row.sha).toBeNull();
    expect(row.result).toBe('failed');
  });

  it('caps marks at 200', () => {
    const home = tmp();
    const rec = createDeployRecorder({ operation: 'deploy', config: CONFIG, home });
    for (let i = 0; i < 250; i++) rec.onStep({ step: `s${i}`, class: 'live' });
    rec.finish({ result: 'ok', sha: null });
    expect(lines(home)[0].marks).toHaveLength(200);
  });

  it('writes exactly one line and a second finish is a no-op', () => {
    const home = tmp();
    const rec = createDeployRecorder({ operation: 'deploy', config: CONFIG, home });
    rec.finish({ result: 'ok', sha: null });
    rec.finish({ result: 'failed', sha: null });
    expect(lines(home)).toHaveLength(1);
    expect(lines(home)[0].result).toBe('ok');
  });

  it('creates the file as 0600 and its directory as 0700', () => {
    const home = tmp();
    createDeployRecorder({ operation: 'deploy', config: CONFIG, home }).finish({ result: 'ok', sha: null });
    expect(fs.statSync(historyFile(home)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(historyDir(home)).mode & 0o777).toBe(0o700);
  });

  it('starts a record on its own line after an unterminated earlier write', () => {
    const home = tmp();
    fs.mkdirSync(historyDir(home), { recursive: true, mode: 0o700 });
    fs.writeFileSync(historyFile(home), '{"partial":', { mode: 0o600 });
    fs.chmodSync(historyFile(home), 0o600);
    createDeployRecorder({ operation: 'deploy', config: CONFIG, home }).finish({ result: 'ok', sha: SHA });
    const text = fs.readFileSync(historyFile(home), 'utf8');
    expect(text.startsWith('{"partial":\n')).toBe(true);
    const last = JSON.parse(text.split('\n').filter(Boolean).pop()!);
    expect(last).toMatchObject({ operation: 'deploy', sha: SHA });
  });

  it('never writes a planted env secret or step-text secret', () => {
    const home = tmp();
    vi.stubEnv('DEPLOY_SECRET_TOKEN', 'hunter2-planted');
    try {
      const rec = createDeployRecorder({ operation: 'deploy', config: CONFIG, home });
      rec.onStep({ step: 'hunter2-planted token', class: 'live' });
      rec.finish({ result: 'ok', sha: null });
    } finally { vi.unstubAllEnvs(); }
    expect(fs.readFileSync(historyFile(home), 'utf8')).not.toContain('hunter2');
  });

  it('does not alter or throw on what onStep receives', () => {
    const rec = createDeployRecorder({ operation: 'deploy', config: CONFIG, home: tmp() });
    const event = Object.freeze({ step: 'build', class: 'staging' });
    expect(() => rec.onStep(event)).not.toThrow();
    expect(event).toEqual({ step: 'build', class: 'staging' });
  });

  describe('unsafe locations warn once, write nothing and never throw', () => {
    const run = (home: string) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(() => createDeployRecorder({ operation: 'deploy', config: CONFIG, home }).finish({ result: 'ok', sha: null })).not.toThrow();
      return warn;
    };

    it('symlinked history file', () => {
      const home = tmp(); const target = path.join(tmp(), 'victim');
      fs.mkdirSync(historyDir(home), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, '');
      fs.symlinkSync(target, historyFile(home));
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^deploy-kit: deploy history not recorded \(history file unavailable\)$/);
      expect(fs.readFileSync(target, 'utf8')).toBe('');
    });

    it('symlinked directory', () => {
      const home = tmp(); const real = tmp();
      fs.mkdirSync(path.join(home, '.cache'));
      fs.symlinkSync(real, historyDir(home));
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(real)).toEqual([]);
    });

    it('group-writable directory', () => {
      const home = tmp();
      fs.mkdirSync(historyDir(home), { recursive: true });
      fs.chmodSync(historyDir(home), 0o770);
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(historyFile(home))).toBe(false);
    });

    it('existing 0755 directory', () => {
      const home = tmp();
      fs.mkdirSync(historyDir(home), { recursive: true });
      fs.chmodSync(historyDir(home), 0o755);
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(historyFile(home))).toBe(false);
    });

    it.skipIf(process.platform === 'win32')('FIFO in place of the history file', () => {
      const home = tmp();
      fs.mkdirSync(historyDir(home), { recursive: true, mode: 0o700 });
      expect(spawnSync('mkfifo', [historyFile(home)]).status).toBe(0);
      // 0600 like a real history file, so only the regular-file check can reject it.
      fs.chmodSync(historyFile(home), 0o600);
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/^deploy-kit: deploy history not recorded \(history file (unavailable|unsafe)\)$/);
      expect(fs.statSync(historyFile(home)).isFIFO()).toBe(true);
    }, 5000);

    it('non-regular file (a directory in its place)', () => {
      const home = tmp();
      fs.mkdirSync(historyFile(home), { recursive: true });
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(fs.statSync(historyFile(home)).isDirectory()).toBe(true);
    });

    it('existing file with loose mode', () => {
      const home = tmp();
      fs.mkdirSync(historyDir(home), { recursive: true, mode: 0o700 });
      fs.writeFileSync(historyFile(home), '', { mode: 0o644 });
      fs.chmodSync(historyFile(home), 0o644);
      const warn = run(home);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(historyFile(home), 'utf8')).toBe('');
    });
  });
});

describe('cli deploy and rollback recording', () => {
  function withConfig(fn: (dir: string) => void) {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, '.deploy-kit.config.json'), JSON.stringify({ host: 'deploy@example.test', projectDir: '/srv/app' }));
    fn(dir);
  }
  function capture() {
    const errors: string[] = [];
    for (const m of ['success', 'info', 'step', 'header', 'warning', 'divider']) if (log[m]) vi.spyOn(log, m).mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation((m) => { errors.push(String(m)); });
    return errors;
  }

  it('deploy success writes one ok line with the sha and the steps', () => {
    withConfig((dir) => {
      const home = tmp(); capture();
      vi.spyOn(deployOps, 'deploy').mockImplementation((_c, _o, ctx) => { ctx.onStep({ step: 'build', class: 'staging' }); });
      expect(cli.run(['deploy', '--sha', SHA, '--no-auto-cut'], { cwd: dir, env: {}, home })).toBe(0);
      const rows = lines(home);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: 'deploy', result: 'ok', sha: SHA, marks: [{ step: 'build', class: 'staging' }] });
    });
  });

  it('deploy failure writes one failed line and keeps the exit code and log line', () => {
    withConfig((dir) => {
      const home = tmp(); const errors = capture();
      vi.spyOn(deployOps, 'deploy').mockImplementation(() => { throw new Error('boom'); });
      expect(cli.run(['deploy'], { cwd: dir, env: {}, home })).toBe(1);
      expect(errors).toEqual(['boom']);
      const rows = lines(home);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ operation: 'deploy', result: 'failed', sha: null });
    });
  });

  it('rollback success and failure each write one line with a null sha', () => {
    withConfig((dir) => {
      const home = tmp(); const errors = capture();
      const spy = vi.spyOn(deployOps, 'rollback').mockImplementation(() => {});
      expect(cli.run(['rollback'], { cwd: dir, env: {}, home })).toBe(0);
      spy.mockImplementation(() => { throw new Error('nope'); });
      expect(cli.run(['rollback'], { cwd: dir, env: {}, home })).toBe(1);
      expect(errors).toEqual(['nope']);
      expect(lines(home).map((r) => [r.operation, r.result, r.sha])).toEqual([['rollback', 'ok', null], ['rollback', 'failed', null]]);
    });
  });

  it('a failing history write does not change the deploy result', () => {
    withConfig((dir) => {
      const home = tmp(); capture();
      fs.mkdirSync(path.join(home, '.cache'));
      fs.symlinkSync(tmp(), historyDir(home));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.spyOn(deployOps, 'deploy').mockImplementation(() => {});
      expect(cli.run(['deploy'], { cwd: dir, env: {}, home })).toBe(0);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it('dry run writes nothing, creates no directory and passes the planner ctx untouched', () => {
    withConfig((dir) => {
      const home = tmp(); capture();
      let seen: any;
      vi.spyOn(deployOps, 'deploy').mockImplementation((_c, _o, ctx) => { seen = ctx; });
      expect(cli.run(['deploy', '--dry-run'], { cwd: dir, env: {}, home })).toBe(0);
      expect(fs.existsSync(path.join(home, '.cache'))).toBe(false);
      expect(seen.onStep).toBeUndefined();
    });
  });

  it('an onStep given to the mocked deploy still sees the same arguments', () => {
    withConfig((dir) => {
      const home = tmp(); capture();
      const event = { step: 'flip', class: 'live' };
      let after: unknown;
      vi.spyOn(deployOps, 'deploy').mockImplementation((_c, _o, ctx) => { ctx.onStep(event); after = { ...event }; });
      cli.run(['deploy'], { cwd: dir, env: {}, home });
      expect(after).toEqual({ step: 'flip', class: 'live' });
      expect(event).toEqual({ step: 'flip', class: 'live' });
    });
  });
});

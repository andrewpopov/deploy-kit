import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const require = createRequire(__filename);
const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

const SHA = '0123456789abcdef0123456789abcdef01234567';
let out = '';
const spies = () => ['error', 'info', 'success', 'warning', 'step', 'header', 'divider'].map((m) =>
  vi.spyOn(log, m).mockImplementation((msg: string) => { out += `${msg}\n`; }));

function inProject(config: Record<string, unknown>, fn: (dir: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-on-host-cli-'));
  fs.writeFileSync(path.join(dir, '.deploy-kit.config.json'), JSON.stringify({
    host: 'dkapp@host', projectDir: '/srv/app', appNames: ['app'], layout: { type: 'releases' }, ...config,
  }));
  try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

afterEach(() => { vi.restoreAllMocks(); out = ''; });

describe('deploy --on-host routing', () => {
  it.each([
    [['--dry-run'], 'ONHOST_DRY_RUN'],
    [['--sha', SHA], 'ONHOST_AUTO_CUT'],
    [['--no-auto-cut'], 'ONHOST_NO_SHA'],
    [['--sha', SHA, '--no-auto-cut', '--no-lock'], 'ONHOST_NO_LOCK'],
    [['--sha', SHA, '--no-auto-cut', '--steal-lock'], 'ONHOST_STEAL_LOCK'],
  ])('deploy --on-host %j is refused by name, before any ssh', (flags, code) => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['deploy', '--on-host', ...flags], { cwd })).toBe(1);
    });
    expect(out).toContain(code);
  });

  it('--branch is refused with --on-host', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['deploy', '--on-host', '--branch', 'feature/x', '--sha', SHA, '--no-auto-cut'], { cwd })).toBe(1);
    });
    expect(out).toMatch(/--sha and --branch are mutually exclusive|ONHOST_BRANCH/);
  });

  it('a non-releases config is refused', () => {
    spies();
    inProject({ layout: null }, (cwd) => {
      expect(cli.run(['deploy', '--on-host', '--sha', SHA, '--no-auto-cut'], { cwd })).toBe(1);
    });
    expect(out).toContain('ONHOST_LAYOUT');
  });

  it('--on-host is a deploy-only flag', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['rollback', '--on-host'], { cwd })).toBe(1);
    });
    expect(out).toContain('rollback does not support: --on-host');
  });
});

describe('attach', () => {
  it('needs exactly one run id', () => {
    spies();
    expect(cli.run(['attach'])).toBe(1);
    expect(cli.run(['attach', '--json'])).toBe(1);
    expect(out).toContain('Usage: deploy-kit attach <run-id>');
  });
  it('refuses something that is not a run id without touching the network', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['attach', 'latest'], { cwd })).toBe(1);
    });
    expect(out).toContain('ONHOST_RUN_ID');
  });
});

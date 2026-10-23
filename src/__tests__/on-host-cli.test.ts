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

  it('rollback --on-host needs --to, a full sha; --skip-migrate is not a rollback flag', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['rollback', '--on-host'], { cwd })).toBe(1);
      expect(out).toContain('--to <40-hex> is required');
      expect(cli.run(['rollback', '--on-host', '--to', 'abc123'], { cwd })).toBe(1);
      expect(cli.run(['rollback', '--skip-migrate'], { cwd })).toBe(1);
    });
    expect(out).toContain('rollback does not support: --skip-migrate');
  });

  it('--to without --on-host is refused rather than ignored (a legacy rollback goes to previous, whatever it is)', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['rollback', '--to', SHA], { cwd })).toBe(1);
    });
    expect(out).toContain('only apply with --on-host');
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

describe('recover --on-host, --run-id and artifact routing (BRAIN-636 D8)', () => {
  const RUN_ID = '20261023T100000Z-0123456789ab-00000001';
  const request = ['--request', 'req-1', '--epoch', '0', '--not-after', '1790000000', '--expect-reservation', '{"state":"none","runId":null,"gen":0}'];

  it('recover exists only as `recover --on-host`', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['recover', '--parent-run', RUN_ID, ...request], { cwd })).toBe(1);
    });
    expect(out).toContain('recover only exists as `recover --on-host`');
  });

  it('recover --on-host needs --parent-run, a run id, and takes no --sha or --to', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['recover', '--on-host', ...request], { cwd })).toBe(1);
      expect(out).toContain('--parent-run must be the run id');
      expect(cli.run(['recover', '--on-host', '--parent-run', 'nope', ...request], { cwd })).toBe(1);
      expect(cli.run(['recover', '--on-host', '--parent-run', RUN_ID, '--sha', SHA, ...request], { cwd })).toBe(1);
      expect(cli.run(['recover', '--on-host', '--parent-run', RUN_ID, '--to', SHA, ...request], { cwd })).toBe(1);
    });
    expect(out).toContain('recover does not support: --sha');
    expect(out).toContain('recover does not support: --to');
  });

  it('--parent-run is only a recover flag', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['deploy', '--on-host', '--sha', SHA, '--no-auto-cut', '--parent-run', RUN_ID], { cwd })).toBe(1);
    });
    expect(out).toContain('deploy does not support: --parent-run');
  });

  it('a malformed --run-id is refused by name, before any ssh', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['deploy', '--on-host', '--sha', SHA, '--no-auto-cut', '--run-id', 'run-1'], { cwd })).toBe(1);
    });
    expect(out).toContain('ONHOST_RUN_ID');
  });

  it('--run-id without --on-host is refused rather than ignored', () => {
    spies();
    inProject({}, (cwd) => {
      expect(cli.run(['deploy', '--run-id', RUN_ID], { cwd })).toBe(1);
      expect(cli.run(['rollback', '--run-id', RUN_ID], { cwd })).toBe(1);
    });
    expect(out).toContain('deploy: --run-id only applies with --on-host');
    expect(out).toContain('only apply with --on-host');
  });

  it('artifact --json prints the installed kit identity as the only stdout', () => {
    spies();
    const printed: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message: string) => { printed.push(message); });
    expect(cli.run(['artifact', '--json'])).toBe(0);
    expect(JSON.parse(printed.join('\n'))).toMatchObject({ version: require('../../package.json').version });
    expect(cli.run(['artifact'])).toBe(1);
    expect(out).toContain('Usage: deploy-kit artifact --json');
  });
});

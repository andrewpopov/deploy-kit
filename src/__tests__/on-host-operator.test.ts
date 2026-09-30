import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const require = createRequire(__filename);
const op = require('../on-host/operator.js');
const { onHostDeploy, validateOnHostRequest, parsePreflight, buildBundle, buildSubmitArgv, quoteArgv, newRunId, systemdEscape } = op;
const { shQuote } = require('../exec.js');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const baseConfig = (over: Record<string, unknown> = {}) => ({
  host: 'dkapp@host', mode: 'ssh', projectDir: '/srv/app', appNames: ['app'], layout: { type: 'releases' }, lock: true, stepTimeoutSeconds: 120,
  ssh: { options: ['Port=2299', 'IdentityFile=/k/id'], strictHostKeyChecking: 'no' }, ...over,
});
const baseOptions = (over: Record<string, unknown> = {}) => ({ sha: SHA, autoCut: false, ...over });

const PREFLIGHT_LINES: Record<string, string> = {
  DK_USER: 'dkapp', DK_UID: '1000', DK_LINGER: 'yes', DK_USER_MANAGER: 'yes', DK_NODE: '/usr/bin/node', DK_NODE_MAJOR: '24', DK_ACTIVE_UNITS: '0',
  DK_SHELL: '/bin/bash', DK_UMASK: '0027', DK_OOM: '100', DK_PATH: '/usr/local/bin:/usr/bin', DK_HOME: '/srv/dkapp', DK_LOGNAME: 'dkapp', ENV_LANG: 'C.UTF-8', ENVABSENT_PM2_HOME: '1', DK_END: '1',
};
const hex = (v: string) => Buffer.from(v, 'utf8').toString('hex');
const preflight = (over: Record<string, string | null> = {}) => Object.entries({ ...PREFLIGHT_LINES, ...over })
  .filter(([, v]) => v !== null).map(([k, v]) => `${k}=${hex(v as string)}`).join('\n') + '\n';

describe('flag and config refusals', () => {
  const refuses = (config: unknown, options: unknown, code: string) => {
    expect(() => validateOnHostRequest(config, options)).toThrow(new RegExp(`^${code}:`));
  };
  it('accepts the documented invocation', () => {
    expect(() => validateOnHostRequest(baseConfig(), baseOptions())).not.toThrow();
  });
  it.each([
    ['--dry-run', { dryRun: true }, 'ONHOST_DRY_RUN'],
    ['--no-lock', { lock: false }, 'ONHOST_NO_LOCK'],
    ['--steal-lock', { stealLock: true }, 'ONHOST_STEAL_LOCK'],
    ['--branch', { branch: 'main' }, 'ONHOST_BRANCH'],
    ['--no-stash', { stash: false }, 'ONHOST_NO_STASH'],
    ['missing --sha', { sha: undefined }, 'ONHOST_NO_SHA'],
    ['abbreviated --sha', { sha: 'abc1234' }, 'ONHOST_NO_SHA'],
    ['missing --no-auto-cut', { autoCut: undefined }, 'ONHOST_AUTO_CUT'],
  ])('refuses %s', (_name, over, code) => refuses(baseConfig(), baseOptions(over), code));
  it.each([
    ['legacy layout', { layout: null }, 'ONHOST_LAYOUT'],
    ['local mode', { mode: 'local' }, 'ONHOST_MODE'],
    ['no host', { host: undefined }, 'ONHOST_HOST'],
    ['option-looking host', { host: '-oProxyCommand=x' }, 'ONHOST_HOST'],
    ['lock false', { lock: false }, 'ONHOST_LOCK'],
    ['null step timeout', { stepTimeoutSeconds: null }, 'ONHOST_STEP_TIMEOUT'],
    ['zero step timeout', { stepTimeoutSeconds: 0 }, 'ONHOST_STEP_TIMEOUT'],
    ['relative projectDir', { projectDir: '~/app' }, 'ONHOST_PROJECT_DIR'],
  ])('refuses config: %s', (_name, over, code) => refuses(baseConfig(over), baseOptions(), code));

  it.each(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'PM2_HOME', 'XDG_RUNTIME_DIR', 'NODE_OPTIONS', 'INVOCATION_ID'])(
    'refuses onHost.env name %s even when load-time validation was bypassed', (name) => {
      refuses(baseConfig({ onHost: { env: [name] } }), baseOptions(), 'ONHOST_ENV');
    });
  it('refuses a malformed onHost.env name and accepts an ordinary one', () => {
    refuses(baseConfig({ onHost: { env: ['lower'] } }), baseOptions(), 'ONHOST_ENV');
    expect(() => validateOnHostRequest(baseConfig({ onHost: { env: ['DATABASE_URL'] } }), baseOptions())).not.toThrow();
  });
});

describe('preflight parsing', () => {
  const quietLog = { warning: vi.fn() };
  it('returns the capture', () => {
    const cap = parsePreflight(preflight(), baseConfig(), quietLog);
    expect(cap).toMatchObject({ user: 'dkapp', uid: '1000', home: '/srv/dkapp', shell: '/bin/bash', umask: '0027', oomScoreAdj: 100, node: '/usr/bin/node', env: { LANG: 'C.UTF-8' }, absentEnv: ['PM2_HOME'] });
  });
  it.each([
    ['ONHOST_NO_LINGER', { DK_LINGER: 'no' }],
    ['ONHOST_NO_USER_MANAGER', { DK_USER_MANAGER: 'no' }],
    ['ONHOST_NODE', { DK_NODE: '' }],
    ['ONHOST_NODE', { DK_NODE_MAJOR: '18' }],
    ['ONHOST_ALREADY_RUNNING', { DK_ACTIVE_UNITS: '1' }],
    ['ONHOST_PREFLIGHT', { DK_SHELL: 'bash' }],
    ['ONHOST_PREFLIGHT', { DK_UMASK: 'rw' }],
    ['ONHOST_PREFLIGHT', { DK_HOME: '/srv/my home' }],
    ['ONHOST_PREFLIGHT', { DK_OOM: null }],
    ['ONHOST_PREFLIGHT', { DK_END: null }],
  ])('refuses with %s', (code, over) => {
    expect(() => parsePreflight(preflight(over as Record<string, string | null>), baseConfig(), quietLog)).toThrow(new RegExp(`^${code}:`));
  });
  it('rejects a repeated key (an injected line cannot override a captured value)', () => {
    expect(() => parsePreflight(`${preflight()}DK_LINGER=${hex('yes')}\n`, baseConfig(), quietLog)).toThrow(/^ONHOST_PREFLIGHT:/);
  });
  it('captures onHost.env names, recording absent ones as absent', () => {
    const cap = parsePreflight(preflight({ ENV_DATABASE_URL: 'pg://x', ENVABSENT_MISSING_ONE: '1' }), baseConfig({ onHost: { env: ['DATABASE_URL', 'MISSING_ONE'] } }), quietLog);
    expect(cap.env).toEqual({ LANG: 'C.UTF-8', DATABASE_URL: 'pg://x' });
    expect(cap.absentEnv).toEqual(['PM2_HOME', 'MISSING_ONE']);
  });
  it('only warns when NODE_OPTIONS is set', () => {
    const log = { warning: vi.fn() };
    parsePreflight(preflight({ DK_NODE_OPTIONS_SET: '1' }), baseConfig(), log);
    expect(log.warning).toHaveBeenCalledTimes(1);
  });
});

const PREFLIGHT_PLAIN = Object.entries(PREFLIGHT_LINES).filter(([k]) => !k.startsWith('ENV') && k !== 'DK_END')
  .map(([k, v]) => `${k}=${hex(v)}`).join('\n') + '\n';

describe('preflight line protocol (review finding 1, 3, 4)', () => {
  const quietLog = { warning: vi.fn() };
  const config = baseConfig({ onHost: { env: ['HOSTILE', 'EMPTY', 'LANG', 'HOSTILE', 'ABSENT_ONE'] } });

  // Runs the REAL generated script under sh with a hostile environment, then parses its real output.
  function runScript(env: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-pf-'));
    try {
      return execFileSync('sh', ['-se'], {
        input: op.preflightScript(config), encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: process.env.PATH, HOME: dir, USER: 'dkapp', ...env },
      });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('carries a hostile multi-line value through as data; a forged key never appears', () => {
    const hostile = 'x\nENV_PM2_HOME=/tmp/x\nDK_LINGER=yes\nDK_END=1';
    const output = runScript({ HOSTILE: hostile, EMPTY: '', LANG: 'C' });
    const kv = op.parseKeyValues(output);
    expect(kv.get('ENV_HOSTILE')).toBe(hostile);
    expect(kv.has('ENV_PM2_HOME')).toBe(false);
    expect(kv.get('DK_LINGER')).not.toBe('yes');
    for (const line of output.split('\n')) expect(line).toMatch(/^([A-Z0-9_]+=([0-9a-f]{2})*)?$/);
  });

  it('allows a present-but-empty value, keeps absent distinct, and dedupes names', () => {
    const output = runScript({ HOSTILE: 'v', EMPTY: '', LANG: 'C' });
    expect(output.match(/^ENV_LANG=/gm)).toHaveLength(1);
    expect(output.match(/^ENV_HOSTILE=/gm)).toHaveLength(1);
    const cap = parsePreflight(`${PREFLIGHT_PLAIN}${output.split('\n').filter((l: string) => /^ENV/.test(l)).join('\n')}\nDK_END=${hex('1')}\n`, config, quietLog);
    expect(cap.env).toMatchObject({ EMPTY: '', HOSTILE: 'v', LANG: 'C' });
    expect(cap.absentEnv).toEqual(expect.arrayContaining(['PM2_HOME', 'ABSENT_ONE']));
    expect('EMPTY' in cap.env).toBe(true);
  });

  it('still refuses control characters in a NON-empty value', () => {
    expect(() => parsePreflight(preflight({ ENV_LANG: 'a\u0001b' }), baseConfig(), quietLog)).toThrow(/control characters/);
  });

  it('refuses any raw (non-hex) protocol line', () => {
    expect(() => parsePreflight(`${preflight()}ENV_PM2_HOME=/tmp/x\n`, baseConfig(), quietLog)).toThrow(/^ONHOST_PREFLIGHT:/);
  });

  it('never emits a name twice in the submitted argv', () => {
    const capture = { user: 'u', uid: '1', home: '/h', shell: '/bin/sh', umask: '0022', oomScoreAdj: 0, node: '/n', logname: 'u', path: '/bin', env: { LANG: 'C', X: '1' }, absentEnv: [] };
    const argv = buildSubmitArgv({ unit: 'u', runDir: '/r', projectDir: '/p', capture, onHostEnv: ['LANG', 'X', 'X'] });
    expect(argv.filter((a: string) => a.startsWith('LANG='))).toHaveLength(1);
    expect(argv.filter((a: string) => a.startsWith('X='))).toHaveLength(1);
  });
});

describe('bundle', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-bundle-')); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it('holds real files only, no __tests__, and a manifest over kit + config.json + meta.json', () => {
    const kitRoot = path.join(tmp, 'kitroot');
    const yaml = path.join(tmp, 'yaml');
    fs.mkdirSync(path.join(kitRoot, 'src', '__tests__'), { recursive: true });
    fs.mkdirSync(path.join(kitRoot, 'src', 'on-host'), { recursive: true });
    fs.mkdirSync(yaml);
    fs.writeFileSync(path.join(kitRoot, 'package.json'), '{"name":"k"}');
    fs.writeFileSync(path.join(kitRoot, 'src', 'cli.js'), 'cli');
    fs.writeFileSync(path.join(kitRoot, 'src', 'on-host', 'record.sh'), '#!/bin/sh');
    fs.writeFileSync(path.join(kitRoot, 'src', '__tests__', 'x.test.ts'), 'test');
    fs.writeFileSync(path.join(tmp, 'outside.js'), 'outside content');
    fs.symlinkSync(path.join(tmp, 'outside.js'), path.join(kitRoot, 'src', 'linked.js'));
    fs.writeFileSync(path.join(yaml, 'package.json'), '{"name":"js-yaml"}');
    fs.writeFileSync(path.join(yaml, 'index.js'), 'yaml');

    const bundle = path.join(tmp, 'bundle');
    fs.mkdirSync(bundle);
    const { files, manifest } = buildBundle(bundle, { kitRoot, jsYamlDir: yaml, config: { mode: 'local' }, meta: { runId: 'r' } });

    expect(fs.existsSync(path.join(bundle, 'kit', 'src', '__tests__'))).toBe(false);
    expect(fs.lstatSync(path.join(bundle, 'kit', 'src', 'linked.js')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(bundle, 'kit', 'src', 'linked.js'), 'utf8')).toBe('outside content');
    expect(files).toEqual([
      'config.json', 'kit/node_modules/js-yaml/index.js', 'kit/node_modules/js-yaml/package.json', 'kit/package.json',
      'kit/src/cli.js', 'kit/src/linked.js', 'kit/src/on-host/record.sh', 'meta.json',
    ]);
    const digest = (rel: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(bundle, rel))).digest('hex');
    for (const rel of files) expect(manifest).toContain(`${digest(rel)}  ${rel}\n`);
    expect(manifest).toContain(`${digest('meta.json')}  meta.json`);
    expect(fs.readFileSync(path.join(bundle, 'manifest.sha256'), 'utf8')).toBe(manifest);
  });

  it('bundles the real kit: js-yaml resolved, this kit\'s tests left out, record.sh present', () => {
    const bundle = path.join(tmp, 'real');
    fs.mkdirSync(bundle);
    const { files } = buildBundle(bundle, { kitRoot: REPO_ROOT, jsYamlDir: op.jsYamlRoot(), config: {}, meta: {} });
    expect(files).toContain('kit/src/on-host/record.sh');
    expect(files).toContain('kit/node_modules/js-yaml/package.json');
    expect(files.some((f: string) => f.includes('__tests__'))).toBe(false);
  });
});

describe('systemd-run argv', () => {
  const capture = {
    user: 'dkapp', uid: '1000', home: '/srv/dkapp', shell: '/bin/bash', umask: '0027', oomScoreAdj: 0, node: '/usr/bin/node', logname: 'dkapp',
    path: '/usr/local/bin:/usr/bin', env: { LANG: 'C.UTF-8', DATABASE_URL: 'pg://x' }, absentEnv: ['PM2_HOME'],
  };
  const RUN_ID = '20260930T120000Z-0123456789ab-deadbeef';
  const runDir = `/srv/dkapp/.deploy-kit/runs/${RUN_ID}`;
  const unit = `deploy-kit-srv-app-${RUN_ID}`;

  it('matches the spec exactly', () => {
    const argv = buildSubmitArgv({ unit, runDir, projectDir: '/srv/app', capture, onHostEnv: ['DATABASE_URL', 'MISSING'] });
    expect(argv).toEqual([
      'systemd-run', '--user', `--unit=${unit}`,
      '--property=Type=exec', '--property=KillMode=process', '--property=OOMPolicy=continue', '--property=TasksMax=infinity',
      '--property=UMask=0027', '--property=WorkingDirectory=/srv/app',
      `--property=StandardOutput=append:${runDir}/log`, `--property=StandardError=append:${runDir}/log`,
      `--property=ExecStopPost=/bin/sh ${runDir}/kit/src/on-host/record.sh ${runDir}`,
      '--',
      '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin', 'HOME=/srv/dkapp', 'USER=dkapp', 'LOGNAME=dkapp', 'SHELL=/bin/bash', 'LANG=C.UTF-8',
      'XDG_RUNTIME_DIR=/run/user/1000', 'INVOCATION_ID=${INVOCATION_ID}', 'DATABASE_URL=pg://x',
      '/usr/bin/node', `${runDir}/kit/src/cli.js`, 'host-run', runDir,
    ]);
    const joined = argv.join(' ');
    for (const banned of ['RuntimeMaxSec', '--collect', '--wait']) expect(joined).not.toContain(banned);
  });

  it('survives hostile values: each stays ONE shell word, nothing expands locally, `$` is doubled but `%` is left literal', () => {
    const hostile = { ...capture, path: `/bin:$(touch /tmp/pwn);'"\`x\` %h $HOME`, env: { LANG: 'a b;c', DATABASE_URL: "x' ; touch /tmp/pwn2 #" } };
    const argv = buildSubmitArgv({ unit, runDir, projectDir: '/srv/app', capture: hostile, onHostEnv: ['DATABASE_URL'] });
    const command = quoteArgv(argv);
    const words = execFileSync('sh', ['-c', `for a in ${command}; do printf '%s\\0' "$a"; done`], { encoding: 'utf8' }).split('\0').slice(0, -1);
    expect(words).toEqual(argv);
    expect(argv).toContain("PATH=/bin:$$(touch /tmp/pwn);'\"`x` %h $$HOME");
    expect(argv).toContain('LANG=a b;c');
    expect(argv).toContain("DATABASE_URL=x' ; touch /tmp/pwn2 #");
    expect(argv).toContain('INVOCATION_ID=${INVOCATION_ID}');
    expect(fs.existsSync('/tmp/pwn')).toBe(false);
    expect(systemdEscape('p%40ss$x')).toBe('p%40ss$$x');   // % is left alone: no specifier expansion in ExecStart argv
  });
});

describe('the flow, against a scripted host', () => {
  let tmp: string;
  let receiptsPath: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-operator-')); receiptsPath = path.join(tmp, 'receipts.jsonl'); });
  afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  type Kind = 'preflight' | 'upload' | 'verify' | 'submit';
  function host(over: Partial<Record<Kind, () => string | Error>> = {}) {
    const calls: { kind: Kind; args: string[]; input?: unknown; receiptBefore: boolean }[] = [];
    const execFileSync = vi.fn((_file: string, args: string[], opts: { input?: unknown }) => {
      const command = args[args.length - 1];
      const kind: Kind = command === 'sh -se' ? 'preflight' : command.includes('tar -x') ? 'upload' : command.includes('sha256sum -c') ? 'verify' : 'submit';
      calls.push({ kind, args, input: opts.input, receiptBefore: fs.existsSync(receiptsPath) && fs.readFileSync(receiptsPath, 'utf8').trim() !== '' });
      const answer = over[kind] ? over[kind]!() : (kind === 'preflight' ? preflight() : '');
      if (answer instanceof Error) throw answer;
      return answer;
    });
    return { calls, runtime: { execFileSync } };
  }
  const messages: string[] = [];
  const log = { info: (m: string) => messages.push(m), warning: (m: string) => messages.push(m), error: (m: string) => messages.push(m), success: (m: string) => messages.push(m) };
  const deps = (h: ReturnType<typeof host>, extra: Record<string, unknown> = {}) => ({
    runtime: h.runtime, log, receiptsPath, tmpRoot: tmp, gitHead: () => 'c'.repeat(40),
    now: () => new Date('2026-09-30T12:00:00.000Z'), randomHex: () => 'deadbeef', attach: vi.fn(() => 0), ...extra,
  });
  beforeEach(() => { messages.length = 0; });

  it('writes the receipt before anything is uploaded or submitted, and attaches with it', () => {
    const h = host();
    const d = deps(h);
    expect(onHostDeploy(baseConfig(), baseOptions({ skipBuild: true }), d)).toBe(0);
    expect(h.calls.map((c) => c.kind)).toEqual(['preflight', 'upload', 'verify', 'submit']);
    const byKind = Object.fromEntries(h.calls.map((c) => [c.kind, c]));
    expect(byKind.preflight.receiptBefore).toBe(false);
    expect(byKind.upload.receiptBefore).toBe(true);
    expect(byKind.submit.receiptBefore).toBe(true);
    const receipt = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
    const runId = '20260930T120000Z-0123456789ab-deadbeef';
    expect(receipt).toMatchObject({ app: '/srv/app', host: 'dkapp@host', runId, unit: `deploy-kit-srv-app-${runId}`, runDir: `/srv/dkapp/.deploy-kit/runs/${runId}`, sha: SHA });
    expect(messages[0]).toBe(`run: ${runId}  unit: ${receipt.unit}  host: dkapp@host`);
    expect(d.attach).toHaveBeenCalledTimes(1);
    expect(d.attach.mock.calls[0][0]).toEqual(receipt);
  });

  it('puts config ssh options on every ssh call and never cd-s into projectDir', () => {
    const h = host();
    onHostDeploy(baseConfig(), baseOptions(), deps(h));
    for (const call of h.calls) {
      expect(call.args).toEqual(expect.arrayContaining(['-o', 'Port=2299', 'IdentityFile=/k/id', 'StrictHostKeyChecking=no', 'dkapp@host']));
      expect(call.args[call.args.length - 1]).not.toContain('cd /srv/app');
    }
  });

  it('uploads a tar of named entries whose meta.json and config.json are what the manifest hashes', () => {
    const h = host({ preflight: () => preflight({ ENVABSENT_DATABASE_URL: '1' }) });
    onHostDeploy(baseConfig({ onHost: { env: ['DATABASE_URL'] } }), baseOptions({ skipBuild: true, verifyPins: false }), deps(h));
    const upload = h.calls.find((c) => c.kind === 'upload')!;
    expect(upload.args[upload.args.length - 1]).toBe(
      `mkdir -m 700 -p '/srv/dkapp/.deploy-kit/runs' && mkdir -m 700 '/srv/dkapp/.deploy-kit/runs/20260930T120000Z-0123456789ab-deadbeef' && tar -x -C '/srv/dkapp/.deploy-kit/runs/20260930T120000Z-0123456789ab-deadbeef'`,
    );
    const dir = path.join(tmp, 'extract');
    fs.mkdirSync(dir);
    execFileSync('tar', ['-x', '-C', dir], { input: upload.input as Buffer });
    expect(fs.readdirSync(dir).sort()).toEqual(['config.json', 'kit', 'manifest.sha256', 'meta.json']);
    const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    expect(config).toMatchObject({ mode: 'local', localShell: '/bin/bash', layout: { type: 'releases' } });
    expect('host' in config).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({
      runId: '20260930T120000Z-0123456789ab-deadbeef', sha: SHA, options: { skipBuild: true, skipDeps: false, skipMigrate: false, verifyPins: false },
      operatorGitHead: 'c'.repeat(40), createdAt: '2026-09-30T12:00:00.000Z', capture: { umask: '0027', oomScoreAdj: 100, shell: '/bin/bash', path: '/usr/local/bin:/usr/bin' },
    });
    const manifest = fs.readFileSync(path.join(dir, 'manifest.sha256'), 'utf8');
    for (const rel of ['meta.json', 'config.json']) {
      const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, rel))).digest('hex');
      expect(manifest).toContain(`${digest}  ${rel}\n`);
    }
    expect(manifest).not.toContain('__tests__');
    expect(manifest).toContain('  kit/node_modules/js-yaml/package.json\n');
  });

  it('submits the spec argv as one shell-quoted ssh command', () => {
    const h = host();
    onHostDeploy(baseConfig(), baseOptions(), deps(h));
    const command = h.calls.find((c) => c.kind === 'submit')!.args.at(-1)!;
    const runDir = '/srv/dkapp/.deploy-kit/runs/20260930T120000Z-0123456789ab-deadbeef';
    expect(command.startsWith(`'systemd-run' '--user' '--unit=deploy-kit-srv-app-20260930T120000Z-0123456789ab-deadbeef' `)).toBe(true);
    expect(command).toContain(`'--property=ExecStopPost=/bin/sh ${runDir}/kit/src/on-host/record.sh ${runDir}'`);
    expect(command).toContain(`'INVOCATION_ID=\${INVOCATION_ID}'`);
    expect(command).toContain(`'/usr/bin/node' '${runDir}/kit/src/cli.js' 'host-run' '${runDir}'`);
    expect(command).not.toMatch(/RuntimeMaxSec|--collect|--wait/);
  });

  it('a lost submission acknowledgement exits 75, prints the attach hint, never resubmits and never attaches', () => {
    const h = host({ submit: () => new Error('ssh: timed out') });
    const d = deps(h);
    expect(onHostDeploy(baseConfig(), baseOptions(), d)).toBe(75);
    expect(h.calls.filter((c) => c.kind === 'submit')).toHaveLength(1);
    expect(messages.join('\n')).toContain('submission outcome unknown — do NOT redeploy; run: deploy-kit attach 20260930T120000Z-0123456789ab-deadbeef');
    expect(d.attach).not.toHaveBeenCalled();
    expect(fs.readFileSync(receiptsPath, 'utf8')).toContain('deadbeef');
  });

  it('a manifest mismatch on the host is ONHOST_MANIFEST and nothing is submitted', () => {
    const h = host({ verify: () => new Error('sha256sum: WARNING: 1 computed checksum did NOT match') });
    const d = deps(h);
    expect(onHostDeploy(baseConfig(), baseOptions(), d)).toBe(1);
    expect(messages.join('\n')).toContain('ONHOST_MANIFEST');
    expect(h.calls.some((c) => c.kind === 'submit')).toBe(false);
    expect(d.attach).not.toHaveBeenCalled();
  });

  it('a failed upload is named and nothing is submitted', () => {
    const h = host({ upload: () => new Error('ssh: broken pipe') });
    expect(onHostDeploy(baseConfig(), baseOptions(), deps(h))).toBe(1);
    expect(messages.join('\n')).toContain('ONHOST_UPLOAD');
    expect(h.calls.map((c) => c.kind)).toEqual(['preflight', 'upload']);
  });

  it.each([
    ['a failed preflight ssh', () => new Error('ssh: no route'), 'ONHOST_PREFLIGHT'],
    ['no linger', () => preflight({ DK_LINGER: 'no' }), 'ONHOST_NO_LINGER'],
    ['an already-running unit', () => preflight({ DK_ACTIVE_UNITS: '1' }), 'ONHOST_ALREADY_RUNNING'],
  ])('%s refuses before any receipt or upload', (_name, answer, code) => {
    const h = host({ preflight: answer as () => string | Error });
    expect(onHostDeploy(baseConfig(), baseOptions(), deps(h))).toBe(1);
    expect(messages.join('\n')).toContain(code);
    expect(h.calls).toHaveLength(1);
    expect(fs.existsSync(receiptsPath)).toBe(false);
  });

  it('a flag refusal contacts no host at all', () => {
    const h = host();
    expect(onHostDeploy(baseConfig(), baseOptions({ dryRun: true }), deps(h))).toBe(1);
    expect(h.calls).toHaveLength(0);
  });

  it('newRunId matches the documented shape', () => {
    expect(newRunId(new Date('2026-09-30T12:00:00.123Z'), SHA, () => 'cafef00d')).toBe('20260930T120000Z-0123456789ab-cafef00d');
  });
  it('the preflight script quotes the lock id into its unit match and lists each onHost.env name', () => {
    const script = op.preflightScript(baseConfig({ projectDir: '/srv/my.app', onHost: { env: ['DATABASE_URL'] } }));
    expect(script).toContain(shQuote('^deploy-kit-srv-my\\.app-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}-[0-9a-f]{8}\\.service$'));
    expect(script).toContain('dk_emit ENV_DATABASE_URL "$DATABASE_URL"');
  });
});

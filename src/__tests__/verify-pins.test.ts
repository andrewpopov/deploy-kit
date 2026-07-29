import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(__filename);
const verifyPinsMod = require('../verify-pins.js') as typeof import('../verify-pins');
const {
  verifyPins, formatReport, parseGithubSpecifier,
} = verifyPinsMod;
const { run } = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
// cli.js does `const { log } = require('./log')` — the SAME singleton object we
// grab here, so spying on its methods captures exactly what the CLI emits (see
// port-guard.test.ts / cli-flags.test.ts for the same pattern).
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

// Real temp directories with real files throughout — no fs mocking. Every
// fixture is a genuine package.json + node_modules/<name>/package.json on
// disk, torn down in afterEach.
const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dk-verify-pins-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop() as string;
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeManifest(dir: string, deps: Record<string, string>, field = 'dependencies') {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', version: '1.0.0', [field]: deps }, null, 2));
}

// Installs a real node_modules/<name>/package.json under `dir` — `name` may be
// scoped (`@andrewpopov/foo`); join() handles the embedded "/" fine.
function install(dir: string, name: string, version: string) {
  const pkgDir = join(dir, 'node_modules', name);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name, version }, null, 2));
}

function captureCli(argv: string[]): { code: number; out: string } {
  let out = '';
  const sink = (m: string): void => { out += String(m) + '\n'; };
  const spies = ['error', 'success', 'info', 'step', 'header', 'warning'].map((m) =>
    log[m] ? vi.spyOn(log, m).mockImplementation(sink) : null,
  );
  try {
    const code = run(argv) as number;
    return { code, out };
  } finally {
    for (const s of spies) s?.mockRestore();
  }
}

describe('parseGithubSpecifier', () => {
  it('parses the `github:owner/repo#ref` shorthand', () => {
    expect(parseGithubSpecifier('github:andrewpopov/url-guard#v0.3.0')).toEqual({
      owner: 'andrewpopov', repo: 'url-guard', ref: 'v0.3.0',
    });
  });

  it('parses the bare `owner/repo#ref` shorthand npm also resolves as GitHub', () => {
    expect(parseGithubSpecifier('andrewpopov/url-guard#main')).toEqual({
      owner: 'andrewpopov', repo: 'url-guard', ref: 'main',
    });
  });

  it('a missing ref parses with ref: null (pins to the default branch)', () => {
    expect(parseGithubSpecifier('github:andrewpopov/url-guard')).toEqual({
      owner: 'andrewpopov', repo: 'url-guard', ref: null,
    });
  });

  it('ignores non-github specifiers', () => {
    expect(parseGithubSpecifier('^1.2.3')).toBeNull();
    expect(parseGithubSpecifier('~1.2.3')).toBeNull();
    expect(parseGithubSpecifier('1.2.3')).toBeNull();
    expect(parseGithubSpecifier('file:../x')).toBeNull();
    expect(parseGithubSpecifier('workspace:*')).toBeNull();
    expect(parseGithubSpecifier('git+https://github.com/andrewpopov/url-guard.git#v1.0.0')).toBeNull();
    expect(parseGithubSpecifier('npm:@scope/pkg@1.2.3')).toBeNull();
  });
});

describe('verifyPins: the core PKG-108 bug', () => {
  it('a matching pin passes', () => {
    const dir = freshDir();
    writeManifest(dir, { 'url-guard': 'github:andrewpopov/url-guard#v0.3.0' });
    install(dir, 'url-guard', '0.3.0');

    const result = verifyPins({ dir });

    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ ok: 1, mismatch: 0, missing: 0, unverifiable: 0 });
    expect(result.entries[0]).toMatchObject({
      name: 'url-guard', status: 'ok', expectedVersion: '0.3.0', installedVersion: '0.3.0',
    });
  });

  it('a mismatched pin FAILS, naming the package, the expected version, and the installed version', () => {
    // The exact real-world scenario this ticket exists to catch: the manifest
    // is bumped to #v0.3.0, but npm's tag-only-bump no-op left 0.2.0 installed.
    const dir = freshDir();
    writeManifest(dir, { 'url-guard': 'github:andrewpopov/url-guard#v0.3.0' });
    install(dir, 'url-guard', '0.2.0');

    const result = verifyPins({ dir });

    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({ ok: 0, mismatch: 1, missing: 0, unverifiable: 0 });
    const entry = result.entries[0];
    expect(entry).toMatchObject({
      name: 'url-guard', status: 'mismatch', expectedVersion: '0.3.0', installedVersion: '0.2.0',
    });
    expect(entry.remediation).toBe('npm install "github:andrewpopov/url-guard#v0.3.0" --save');

    const { problemLines, summaryLine } = formatReport(result);
    const text = problemLines.join('\n');
    expect(text).toContain('url-guard');
    expect(text).toMatch(/want 0\.3\.0/);
    expect(text).toContain('installed 0.2.0');
    expect(text).toContain('npm install "github:andrewpopov/url-guard#v0.3.0" --save');
    expect(summaryLine).toBe('verify-pins: 0 ok, 1 MISMATCH, 0 missing, 0 unverifiable (non-semver refs)');
  });

  it('a pinned-but-not-installed package FAILS as missing', () => {
    const dir = freshDir();
    writeManifest(dir, { 'ghost-pkg': 'github:andrewpopov/ghost-pkg#v1.0.0' });
    // no install() call — node_modules/ghost-pkg never exists

    const result = verifyPins({ dir });

    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({ ok: 0, mismatch: 0, missing: 1, unverifiable: 0 });
    const entry = result.entries[0];
    expect(entry).toMatchObject({ name: 'ghost-pkg', status: 'missing', expectedVersion: '1.0.0' });
    expect(entry.installedVersion).toBeUndefined();
    expect(entry.remediation).toBe('npm install "github:andrewpopov/ghost-pkg#v1.0.0" --save');

    const { problemLines } = formatReport(result);
    expect(problemLines.join('\n')).toMatch(/MISSING.*ghost-pkg.*not installed/s);
  });

  it('a branch, a 40-char commit SHA, and a semver: range are each reported unverifiable — never silently skipped, never failing', () => {
    const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    expect(sha).toHaveLength(40);
    const dir = freshDir();
    writeManifest(dir, {
      'on-main': 'github:andrewpopov/on-main#main',
      'pinned-sha': `github:andrewpopov/pinned-sha#${sha}`,
      'range-pin': 'github:andrewpopov/range-pin#semver:^1.0.0',
    });

    const result = verifyPins({ dir });

    expect(result.ok).toBe(true); // unverifiable never fails the run
    expect(result.summary).toEqual({ ok: 0, mismatch: 0, missing: 0, unverifiable: 3 });
    expect(result.entries.every((e) => e.status === 'unverifiable')).toBe(true);

    const { problemLines, unverifiableLines, summaryLine } = formatReport(result);
    expect(problemLines).toHaveLength(0); // not "problems" — they didn't fail
    expect(unverifiableLines).toHaveLength(3); // but not silently folded away either
    const text = unverifiableLines.join('\n');
    expect(text).toMatch(/on-main/);
    expect(text).toMatch(/pinned-sha/);
    expect(text).toMatch(/range-pin/);
    expect(summaryLine).toBe('verify-pins: 0 ok, 0 MISMATCH, 0 missing, 3 unverifiable (non-semver refs)');
  });

  it('handles both a v-prefixed and a bare semver tag', () => {
    const dir = freshDir();
    writeManifest(dir, {
      'v-pinned': 'github:andrewpopov/v-pinned#v2.0.0',
      'bare-pinned': 'github:andrewpopov/bare-pinned#2.0.0',
    });
    install(dir, 'v-pinned', '2.0.0');
    install(dir, 'bare-pinned', '2.0.0');

    const result = verifyPins({ dir });

    expect(result.ok).toBe(true);
    expect(result.entries.map((e) => [e.name, e.status, e.expectedVersion])).toEqual([
      ['v-pinned', 'ok', '2.0.0'],
      ['bare-pinned', 'ok', '2.0.0'],
    ]);
  });

  it('handles a prerelease tag (v1.8.0-rc.1), both matching and mismatched', () => {
    const okDir = freshDir();
    writeManifest(okDir, { 'rc-pkg': 'github:andrewpopov/rc-pkg#v1.8.0-rc.1' });
    install(okDir, 'rc-pkg', '1.8.0-rc.1');
    const okResult = verifyPins({ dir: okDir });
    expect(okResult.entries[0]).toMatchObject({ status: 'ok', expectedVersion: '1.8.0-rc.1', installedVersion: '1.8.0-rc.1' });

    const mismatchDir = freshDir();
    writeManifest(mismatchDir, { 'rc-pkg': 'github:andrewpopov/rc-pkg#v1.8.0-rc.1' });
    install(mismatchDir, 'rc-pkg', '1.8.0-rc.0');
    const mismatchResult = verifyPins({ dir: mismatchDir });
    expect(mismatchResult.entries[0]).toMatchObject({
      status: 'mismatch', expectedVersion: '1.8.0-rc.1', installedVersion: '1.8.0-rc.0',
    });
  });

  it('ignores non-github specifiers entirely (^1.2.3, file:../x, workspace:*)', () => {
    const dir = freshDir();
    writeManifest(dir, {
      'semver-range': '^1.2.3',
      'file-dep': 'file:../x',
      'workspace-dep': 'workspace:*',
    });

    const result = verifyPins({ dir });

    expect(result.entries).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(result.summary).toEqual({ ok: 0, mismatch: 0, missing: 0, unverifiable: 0 });
  });

  it('resolves a dependency HOISTED to a PARENT directory node_modules (workspace hoisting)', () => {
    const root = freshDir();
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeManifest(nested, { 'hoisted-pkg': 'github:andrewpopov/hoisted-pkg#v1.5.0' });
    install(root, 'hoisted-pkg', '1.5.0'); // installed at the repo ROOT, not packages/api

    const result = verifyPins({ dir: nested });

    expect(result.ok).toBe(true);
    expect(result.entries[0]).toMatchObject({ status: 'ok', installedVersion: '1.5.0' });
  });

  it('a mismatched HOISTED dependency still fails correctly', () => {
    const root = freshDir();
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeManifest(nested, { 'hoisted-pkg': 'github:andrewpopov/hoisted-pkg#v1.5.0' });
    install(root, 'hoisted-pkg', '1.4.0');

    const result = verifyPins({ dir: nested });

    expect(result.ok).toBe(false);
    expect(result.entries[0]).toMatchObject({ status: 'mismatch', expectedVersion: '1.5.0', installedVersion: '1.4.0' });
  });

  it('handles scoped package names (@andrewpopov/foo)', () => {
    const dir = freshDir();
    writeManifest(dir, { '@andrewpopov/foo': 'github:andrewpopov/foo#v3.0.0' });
    install(dir, '@andrewpopov/foo', '3.0.0');

    const result = verifyPins({ dir });

    expect(result.ok).toBe(true);
    expect(result.entries[0]).toMatchObject({ name: '@andrewpopov/foo', status: 'ok' });
  });

  it('checks every dependency field (dependencies/devDependencies/optionalDependencies/peerDependencies)', () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'consumer',
      version: '1.0.0',
      dependencies: { 'dep-pkg': 'github:andrewpopov/dep-pkg#v1.0.0' },
      devDependencies: { 'dev-pkg': 'github:andrewpopov/dev-pkg#v1.0.0' },
      optionalDependencies: { 'opt-pkg': 'github:andrewpopov/opt-pkg#v1.0.0' },
      peerDependencies: { 'peer-pkg': 'github:andrewpopov/peer-pkg#v1.0.0' },
    }, null, 2));
    install(dir, 'dep-pkg', '1.0.0');
    install(dir, 'dev-pkg', '1.0.0');
    install(dir, 'opt-pkg', '1.0.0');
    install(dir, 'peer-pkg', '1.0.0');

    const result = verifyPins({ dir });

    expect(result.ok).toBe(true);
    expect(result.entries.map((e) => e.field).sort()).toEqual([
      'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
    ]);
  });
});

describe('CLI: deploy-kit verify-pins', () => {
  it('exits 0 on a clean run', () => {
    const dir = freshDir();
    writeManifest(dir, { 'good-pkg': 'github:andrewpopov/good-pkg#v1.0.0' });
    install(dir, 'good-pkg', '1.0.0');

    const { code, out } = captureCli(['verify-pins', '--dir', dir]);

    expect(code).toBe(0);
    expect(out).toMatch(/1 ok, 0 MISMATCH, 0 missing, 0 unverifiable/);
  });

  it('exits non-zero on a mismatch and prints the package/expected/installed', () => {
    const dir = freshDir();
    writeManifest(dir, { 'bad-pkg': 'github:andrewpopov/bad-pkg#v2.0.0' });
    install(dir, 'bad-pkg', '1.0.0');

    const { code, out } = captureCli(['verify-pins', '--dir', dir]);

    expect(code).not.toBe(0);
    expect(out).toMatch(/MISMATCH/);
    expect(out).toContain('bad-pkg');
    expect(out).toContain('2.0.0');
    expect(out).toContain('1.0.0');
  });

  it('--dir defaults to cwd when omitted', () => {
    const dir = freshDir();
    writeManifest(dir, { 'good-pkg': 'github:andrewpopov/good-pkg#v1.0.0' });
    install(dir, 'good-pkg', '1.0.0');

    let out = '';
    const sink = (m: string): void => { out += String(m) + '\n'; };
    const spies = ['error', 'success', 'info', 'warning'].map((m) => vi.spyOn(log, m).mockImplementation(sink));
    try {
      const code = run(['verify-pins'], { cwd: dir }) as number;
      expect(code).toBe(0);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    expect(out).toMatch(/1 ok, 0 MISMATCH, 0 missing, 0 unverifiable/);
  });

  it('--json prints a machine-readable result and still reflects exit code in ok', () => {
    const dir = freshDir();
    writeManifest(dir, { 'json-pkg': 'github:andrewpopov/json-pkg#v1.0.0' });
    install(dir, 'json-pkg', '1.0.0');

    let printed = '';
    const orig = console.log;
    console.log = (m: string) => { printed += m; };
    let code: number;
    try {
      code = run(['verify-pins', '--dir', dir, '--json']) as number;
    } finally {
      console.log = orig;
    }

    expect(code).toBe(0);
    const parsed = JSON.parse(printed);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries[0]).toMatchObject({ name: 'json-pkg', status: 'ok' });
  });

  it('rejects an unknown flag before any dispatch', () => {
    expect(() => run(['verify-pins', '--bogus'])).toThrow(/Unknown argument: --bogus/);
  });

  it('a directory with no package.json fails loudly with a clear message, not a stack trace', () => {
    const dir = freshDir();

    const { code, out } = captureCli(['verify-pins', '--dir', dir]);

    expect(code).toBe(1);
    expect(out).toMatch(/verify-pins: cannot read/);
  });
});

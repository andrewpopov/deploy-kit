import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawnSync } from 'child_process';

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
    expect(result.summary).toEqual({ ok: 1, mismatch: 0, missing: 0, unverifiable: 0, absent: 0, corrupt: 0, manifests: 1 });
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
    expect(result.summary).toEqual({ ok: 0, mismatch: 1, missing: 0, unverifiable: 0, absent: 0, corrupt: 0, manifests: 1 });
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
    expect(summaryLine).toBe('verify-pins: 0 ok, 1 MISMATCH, 0 missing, 0 unverifiable (non-semver refs), 0 absent, 0 corrupt');
  });

  it('a pinned-but-not-installed package FAILS as missing', () => {
    const dir = freshDir();
    writeManifest(dir, { 'ghost-pkg': 'github:andrewpopov/ghost-pkg#v1.0.0' });
    // no install() call — node_modules/ghost-pkg never exists

    const result = verifyPins({ dir });

    expect(result.ok).toBe(false);
    expect(result.summary).toEqual({ ok: 0, mismatch: 0, missing: 1, unverifiable: 0, absent: 0, corrupt: 0, manifests: 1 });
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
    expect(result.summary).toEqual({ ok: 0, mismatch: 0, missing: 0, unverifiable: 3, absent: 0, corrupt: 0, manifests: 1 });
    expect(result.entries.every((e) => e.status === 'unverifiable')).toBe(true);

    const { problemLines, unverifiableLines, summaryLine } = formatReport(result);
    expect(problemLines).toHaveLength(0); // not "problems" — they didn't fail
    expect(unverifiableLines).toHaveLength(3); // but not silently folded away either
    const text = unverifiableLines.join('\n');
    expect(text).toMatch(/on-main/);
    expect(text).toMatch(/pinned-sha/);
    expect(text).toMatch(/range-pin/);
    expect(summaryLine).toBe('verify-pins: 0 ok, 0 MISMATCH, 0 missing, 3 unverifiable (non-semver refs), 0 absent, 0 corrupt');
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
    expect(result.summary).toEqual({ ok: 0, mismatch: 0, missing: 0, unverifiable: 0, absent: 0, corrupt: 0, manifests: 1 });
  });

  // PKG-108 finding 2: hoisting resolution is legitimate ONLY for a genuine,
  // declared workspace member — the walk is bounded to the workspace root
  // (see resolveInstalled's boundaryDir), never further. These two cases used
  // to hoist from a bare nested directory with NO workspace declaration at
  // all (verifyPins({ dir: nested }) directly, no root manifest even
  // present) — that was the unbounded-ancestor-walk bug itself, not a real
  // hoisting scenario a package manager would ever produce. Rewritten here to
  // run at the declared workspace ROOT, which is how real hoisting happens.
  it('resolves a workspace member\'s dependency HOISTED to the workspace ROOT node_modules', () => {
    const root = freshDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo', version: '1.0.0', workspaces: ['packages/*'],
    }, null, 2));
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeManifest(nested, { 'hoisted-pkg': 'github:andrewpopov/hoisted-pkg#v1.5.0' });
    install(root, 'hoisted-pkg', '1.5.0'); // installed at the workspace ROOT, not packages/api

    const result = verifyPins({ dir: root });

    expect(result.ok).toBe(true);
    const entry = result.entries.find((e: any) => e.name === 'hoisted-pkg');
    expect(entry).toMatchObject({ status: 'ok', installedVersion: '1.5.0' });
  });

  it('a mismatched HOISTED dependency still fails correctly', () => {
    const root = freshDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo', version: '1.0.0', workspaces: ['packages/*'],
    }, null, 2));
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeManifest(nested, { 'hoisted-pkg': 'github:andrewpopov/hoisted-pkg#v1.5.0' });
    install(root, 'hoisted-pkg', '1.4.0');

    const result = verifyPins({ dir: root });

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e: any) => e.name === 'hoisted-pkg');
    expect(entry).toMatchObject({ status: 'mismatch', expectedVersion: '1.5.0', installedVersion: '1.4.0' });
  });

  it('a STANDALONE (non-workspace) manifest does NOT hoist-resolve past its own directory', () => {
    // Same shape as the two tests above, but the root package.json declares
    // no `workspaces` — so `nested` is just an ordinary nested directory, not
    // a workspace member, and its pin must NOT be satisfied by the parent's
    // node_modules. This is finding 2's actual invariant: hoisting requires a
    // real, declared project boundary, not merely "a parent happens to have
    // it".
    const root = freshDir();
    const nested = join(root, 'packages', 'api');
    mkdirSync(nested, { recursive: true });
    writeManifest(nested, { 'hoisted-pkg': 'github:andrewpopov/hoisted-pkg#v1.5.0' });
    install(root, 'hoisted-pkg', '1.5.0'); // present at the parent, but nested has no workspace relation to it

    const result = verifyPins({ dir: nested });

    expect(result.ok).toBe(false);
    expect(result.entries[0]).toMatchObject({ status: 'missing' });
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

describe('PKG-108 review findings (confirmed, with reproductions)', () => {
  // Finding 1 (HIGH): verifyPins reads exactly ONE package.json. Run at a
  // workspace root, every sub-package's pins are silently never checked, and
  // nothing about the summary hints that anything was skipped.
  it('Finding 1: a workspace root run must also check every workspace member manifest, naming the offending manifest path', () => {
    const root = freshDir();
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'monorepo', version: '1.0.0', workspaces: ['packages/*'],
    }, null, 2));
    const apiDir = join(root, 'packages', 'api');
    mkdirSync(apiDir, { recursive: true });
    writeManifest(apiDir, { 'api-pkg': 'github:andrewpopov/api-pkg#v1.0.0' });
    install(apiDir, 'api-pkg', '0.9.0'); // drifted — installed 0.9.0, pin wants 1.0.0

    const result = verifyPins({ dir: root });

    expect(result.ok).toBe(false);
    const entry = result.entries.find((e: any) => e.name === 'api-pkg');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({ status: 'mismatch', expectedVersion: '1.0.0', installedVersion: '0.9.0' });
    expect(entry.manifest).toBe(join('packages', 'api', 'package.json'));
    expect(result.summary.manifests).toBe(2); // root + packages/api

    const { problemLines } = formatReport(result);
    expect(problemLines.join('\n')).toContain(join('packages', 'api', 'package.json'));
  });

  // Finding 2 (HIGH): resolveInstalled walks up to the FILESYSTEM ROOT, so a
  // project that never installed a dependency passes if any ancestor
  // directory happens to have an unrelated copy. Reproduced: outer has a
  // stray node_modules/<pkg>; inner pins the same name and has NO
  // node_modules of its own at all.
  it('Finding 2: a pin is not satisfied by an unrelated package found by walking past the project boundary', () => {
    const outer = freshDir();
    install(outer, '@andrewpopov/ghost', '1.0.0'); // outer/node_modules/@andrewpopov/ghost — unrelated
    const inner = join(outer, 'inner');
    mkdirSync(inner, { recursive: true });
    writeManifest(inner, { '@andrewpopov/ghost': 'github:andrewpopov/ghost#v1.0.0' });
    // outer/inner/node_modules does NOT exist — no install() call for inner

    const result = verifyPins({ dir: inner });

    expect(result.ok).toBe(false);
    expect(result.entries[0]).toMatchObject({ name: '@andrewpopov/ghost', status: 'missing' });
  });

  // Finding 3 (MEDIUM): the version banner is printed to stdout BEFORE the
  // JSON, so `verify-pins --json | jq` fails. Assertions against a stubbed
  // console.log (as the existing --json test does) don't catch this — only a
  // real subprocess with a real stdout stream does.
  it('Finding 3: the real CLI subprocess --json stdout is pure, parseable JSON (no banner)', () => {
    const dir = freshDir();
    writeManifest(dir, { 'good-pkg': 'github:andrewpopov/good-pkg#v1.0.0' });
    install(dir, 'good-pkg', '1.0.0');

    const cliPath = join(__dirname, '..', 'cli.js');
    const proc = spawnSync(process.execPath, [cliPath, 'verify-pins', '--dir', dir, '--json'], { encoding: 'utf8' });

    expect(proc.status).toBe(0);
    const parsed = JSON.parse(proc.stdout); // throws if the banner polluted stdout
    expect(parsed.ok).toBe(true);
    expect(parsed.entries[0]).toMatchObject({ name: 'good-pkg', status: 'ok' });
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

describe('PKG-109: edge cases', () => {
  describe('Fix 1: optionalDependencies/peerDependencies absence is tolerated', () => {
    it('an optional pin absent from node_modules is status "absent", not "missing" — and does not fail the run', () => {
      const dir = freshDir();
      writeManifest(dir, { 'opt-pkg': 'github:andrewpopov/opt-pkg#v1.0.0' }, 'optionalDependencies');
      // no install() call — never installed, which is legal for an optional dep

      const result = verifyPins({ dir });

      expect(result.ok).toBe(true);
      expect(result.summary).toMatchObject({ ok: 0, mismatch: 0, missing: 0, absent: 1 });
      expect(result.entries[0]).toMatchObject({
        name: 'opt-pkg', status: 'absent', expectedVersion: '1.0.0', field: 'optionalDependencies',
      });

      const { absentLines, problemLines, summaryLine } = formatReport(result);
      expect(problemLines).toHaveLength(0);
      expect(absentLines).toHaveLength(1);
      expect(absentLines[0]).toMatch(/opt-pkg/);
      expect(absentLines[0]).toMatch(/want 1\.0\.0/);
      expect(summaryLine).toMatch(/1 absent/);
    });

    it('a peer pin absent from node_modules is status "absent" and does not fail the run', () => {
      const dir = freshDir();
      writeManifest(dir, { 'peer-pkg': 'github:andrewpopov/peer-pkg#v2.0.0' }, 'peerDependencies');

      const result = verifyPins({ dir });

      expect(result.ok).toBe(true);
      expect(result.entries[0]).toMatchObject({ name: 'peer-pkg', status: 'absent', field: 'peerDependencies' });
      expect(result.summary.absent).toBe(1);
    });

    it('a plain dependency (not optional/peer) that is absent is still "missing" and still FAILS', () => {
      const dir = freshDir();
      writeManifest(dir, { 'ghost-pkg': 'github:andrewpopov/ghost-pkg#v1.0.0' });

      const result = verifyPins({ dir });

      expect(result.ok).toBe(false);
      expect(result.entries[0]).toMatchObject({ status: 'missing' });
      expect(result.summary.absent).toBe(0);
    });

    it('REGRESSION: a PRESENT but version-mismatched optional pin is still "mismatch" and still FAILS', () => {
      const dir = freshDir();
      writeManifest(dir, { 'opt-pkg': 'github:andrewpopov/opt-pkg#v1.0.0' }, 'optionalDependencies');
      install(dir, 'opt-pkg', '0.9.0');

      const result = verifyPins({ dir });

      expect(result.ok).toBe(false);
      expect(result.entries[0]).toMatchObject({
        status: 'mismatch', expectedVersion: '1.0.0', installedVersion: '0.9.0',
      });
      expect(result.summary.absent).toBe(0);
    });

    it('REGRESSION: a PRESENT but version-mismatched peer pin is still "mismatch" and still FAILS', () => {
      const dir = freshDir();
      writeManifest(dir, { 'peer-pkg': 'github:andrewpopov/peer-pkg#v1.0.0' }, 'peerDependencies');
      install(dir, 'peer-pkg', '0.9.0');

      const result = verifyPins({ dir });

      expect(result.ok).toBe(false);
      expect(result.entries[0]).toMatchObject({ status: 'mismatch' });
    });
  });

  describe('Fix 2: `#semver:<exact>` and build-metadata refs are verifiable', () => {
    it('a `semver:<exact>` ref is verifiable and compared like a tag', () => {
      const dir = freshDir();
      writeManifest(dir, { 'sem-pkg': 'github:andrewpopov/sem-pkg#semver:1.2.3' });
      install(dir, 'sem-pkg', '1.2.3');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'ok', expectedVersion: '1.2.3' });
    });

    it('a `semver:v<exact>` ref is verifiable too', () => {
      const dir = freshDir();
      writeManifest(dir, { 'sem-pkg': 'github:andrewpopov/sem-pkg#semver:v1.2.3' });
      install(dir, 'sem-pkg', '1.2.3');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'ok', expectedVersion: '1.2.3' });
    });

    it('a `semver:` RANGE (^, x, comparator set) stays unverifiable', () => {
      const dir = freshDir();
      writeManifest(dir, {
        caret: 'github:andrewpopov/caret#semver:^1.2.0',
        xrange: 'github:andrewpopov/xrange#semver:1.x',
        comparator: 'github:andrewpopov/comparator#semver:>=1.0.0 <2.0.0',
      });

      const result = verifyPins({ dir });

      expect(result.entries.every((e) => e.status === 'unverifiable')).toBe(true);
    });

    it('a build-metadata tag (`#v1.2.3+build.1`) is a valid exact tag, not rejected', () => {
      const dir = freshDir();
      writeManifest(dir, { 'build-pkg': 'github:andrewpopov/build-pkg#v1.2.3+build.1' });
      install(dir, 'build-pkg', '1.2.3');

      const result = verifyPins({ dir });

      expect(result.entries[0].status).not.toBe('unverifiable');
    });
  });

  describe('Fix 3: semver equality (v-prefix + build metadata ignored on both sides), tightened grammar', () => {
    it('pin `#v1.2.3+build.1` vs installed `1.2.3` (no v, no build) is ok', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#v1.2.3+build.1' });
      install(dir, 'pkg', '1.2.3');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'ok' });
    });

    it('pin `#1.2.3` vs installed `v1.2.3` (installed carries a leading v) is ok', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3' });
      install(dir, 'pkg', 'v1.2.3');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'ok' });
    });

    it('pin `#1.2.3+build.9` vs installed `v1.2.3+build.1` (different build metadata, both sides decorated) is ok', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3+build.9' });
      install(dir, 'pkg', 'v1.2.3+build.1');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'ok' });
    });

    it('prerelease must still compare exactly: 1.2.3-rc.1 != 1.2.3', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3-rc.1' });
      install(dir, 'pkg', '1.2.3');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'mismatch' });
    });

    it('rejects a leading zero in a numeric identifier (01.2.3) as unverifiable, not a crash', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#01.2.3' });

      const result = verifyPins({ dir });

      expect(result.entries[0].status).toBe('unverifiable');
    });

    it('rejects consecutive dots in prerelease (1.2.3-rc..1) as unverifiable', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3-rc..1' });

      const result = verifyPins({ dir });

      expect(result.entries[0].status).toBe('unverifiable');
    });

    it('rejects a trailing dot in prerelease (1.2.3-rc.) as unverifiable', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3-rc.' });

      const result = verifyPins({ dir });

      expect(result.entries[0].status).toBe('unverifiable');
    });

    it('rejects an empty prerelease (1.2.3-) as unverifiable', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3-' });

      const result = verifyPins({ dir });

      expect(result.entries[0].status).toBe('unverifiable');
    });
  });

  describe('CLI: absentLines are printed as non-error, and the summary carries the absent count', () => {
    it('an optional-dep absence prints as a warning/info line, not an error, and still exits 0', () => {
      const dir = freshDir();
      writeManifest(dir, { 'opt-pkg': 'github:andrewpopov/opt-pkg#v1.0.0' }, 'optionalDependencies');

      const { code, out } = captureCli(['verify-pins', '--dir', dir]);

      expect(code).toBe(0);
      expect(out).not.toMatch(/^MISMATCH|^MISSING/m);
      expect(out).toMatch(/opt-pkg/);
      expect(out).toMatch(/1 absent/);
    });
  });

  it('a MISMATCHED `semver:<exact>` pin still fails (not just the matching path)', () => {
    const dir = freshDir();
    writeManifest(dir, { 'sem-pkg': 'github:andrewpopov/sem-pkg#semver:1.2.3' });
    install(dir, 'sem-pkg', '1.2.4');

    const result = verifyPins({ dir });

    expect(result.ok).toBe(false);
    expect(result.entries[0]).toMatchObject({
      status: 'mismatch', expectedVersion: '1.2.3', installedVersion: '1.2.4',
    });
  });

  describe('Codex review follow-up: a corrupt installed manifest must FAIL, for ANY dep field', () => {
    function installCorrupt(dir: string, name: string) {
      const pkgDir = join(dir, 'node_modules', name);
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), '{ not valid json');
    }

    it('a corrupt installed manifest for an ordinary dependency FAILS as its own status, not "missing"', () => {
      const dir = freshDir();
      writeManifest(dir, { 'dep-pkg': 'github:andrewpopov/dep-pkg#v1.0.0' });
      installCorrupt(dir, 'dep-pkg');

      const result = verifyPins({ dir });

      expect(result.ok).toBe(false);
      expect(result.entries[0].status).toBe('corrupt');
      expect(result.entries[0].status).not.toBe('missing');
    });

    it('a corrupt installed manifest for an OPTIONAL dependency still FAILS — it must NOT be tolerated as "absent"', () => {
      const dir = freshDir();
      writeManifest(dir, { 'opt-pkg': 'github:andrewpopov/opt-pkg#v1.0.0' }, 'optionalDependencies');
      installCorrupt(dir, 'opt-pkg');

      const result = verifyPins({ dir });

      expect(result.ok).toBe(false);
      expect(result.entries[0].status).toBe('corrupt');
      expect(result.entries[0].status).not.toBe('absent');
    });

    it('a corrupt installed manifest for a PEER dependency still FAILS — it must NOT be tolerated as "absent"', () => {
      const dir = freshDir();
      writeManifest(dir, { 'peer-pkg': 'github:andrewpopov/peer-pkg#v1.0.0' }, 'peerDependencies');
      installCorrupt(dir, 'peer-pkg');

      const result = verifyPins({ dir });

      expect(result.ok).toBe(false);
      expect(result.entries[0].status).toBe('corrupt');
    });

    it('formatReport prints a corrupt entry as a problem line (error severity), and it counts in the summary', () => {
      const dir = freshDir();
      writeManifest(dir, { 'dep-pkg': 'github:andrewpopov/dep-pkg#v1.0.0' });
      installCorrupt(dir, 'dep-pkg');

      const result = verifyPins({ dir });
      expect(result.summary.corrupt).toBe(1);

      const { problemLines } = formatReport(result);
      expect(problemLines.join('\n')).toMatch(/dep-pkg/i);
      expect(problemLines.join('\n')).toMatch(/corrupt/i);
    });
  });

  describe('Codex review follow-up: the INSTALLED version is also validated against the semver grammar', () => {
    it('an installed version with trailing invalid build metadata (`1.2.3+`) is a mismatch, not silently accepted', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3' });
      install(dir, 'pkg', '1.2.3+');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'mismatch', installedVersion: '1.2.3+' });
    });

    it('an installed version with malformed build metadata (`1.2.3+build..1`) is a mismatch, not silently accepted', () => {
      const dir = freshDir();
      writeManifest(dir, { pkg: 'github:andrewpopov/pkg#1.2.3' });
      install(dir, 'pkg', '1.2.3+build..1');

      const result = verifyPins({ dir });

      expect(result.entries[0]).toMatchObject({ status: 'mismatch', installedVersion: '1.2.3+build..1' });
    });
  });

  describe('Codex review follow-up: optionalDependencies takes precedence over dependencies for the same name', () => {
    it('a name pinned in BOTH dependencies and optionalDependencies, absent from node_modules, is classified once as tolerated "absent" — not also as a failing "missing"', () => {
      const dir = freshDir();
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'consumer',
        version: '1.0.0',
        dependencies: { 'dual-pkg': 'github:andrewpopov/dual-pkg#v1.0.0' },
        optionalDependencies: { 'dual-pkg': 'github:andrewpopov/dual-pkg#v1.0.0' },
      }, null, 2));
      // no install() call

      const result = verifyPins({ dir });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0]).toMatchObject({ name: 'dual-pkg', status: 'absent', field: 'optionalDependencies' });
      expect(result.ok).toBe(true);
    });
  });
});

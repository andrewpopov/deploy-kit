import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every other auto-cut test drives a FAKE runtime, which accepts any command
 * string it is handed. That makes an invalid git flag invisible: the whole
 * suite passed while auto-cut shipped `--ignore-submodules=no`, which git
 * rejects outright ("fatal: bad --ignore-submodules argument: no" — the valid
 * values are none/untracked/dirty/all). It failed on the first real deploy.
 *
 * So this file asserts the opposite way round: take the git command strings
 * the source actually issues and run them against a REAL throwaway repo. It
 * does not check behaviour — only that git accepts the invocation at all.
 */
function extractGitCommands(file: string): string[] {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const found = new Set<string>();
  for (const m of src.matchAll(/'(git status [^']*)'/g)) found.add(m[1]);
  return [...found];
}

describe('git commands the source issues are accepted by a real git', () => {
  const commands = [...new Set([...extractGitCommands('auto-cut.js'), ...extractGitCommands('deploy.js')])];

  test('there are commands to check (guards against the extractor silently matching nothing)', () => {
    expect(commands.length).toBeGreaterThan(0);
  });

  for (const command of commands) {
    test(`real git accepts: ${command}`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-kit-realgit-'));
      try {
        execFileSync('git', ['init', '-q', dir], { encoding: 'utf8' });
        execFileSync('git', ['-C', dir, 'commit', '-q', '--allow-empty', '-m', 'init'], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.invalid',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.invalid',
          },
        });
        // Throws on a bad flag; a non-zero exit from a legitimately failing
        // query would too, but these are all status queries on a clean repo.
        execFileSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

/**
 * The owner/repo parser used to require a literal `github.com` host. Every
 * repo in this fleet uses an SSH host ALIAS (`git@github-personal:owner/repo.git`,
 * routed to github.com by ~/.ssh/config), so auto-cut aborted on the real
 * remote of every single repo it was meant to serve — invisible to the fake
 * runtime, which returns a canned github.com URL.
 */
describe('remote push URL -> owner/repo', () => {
  const parse = (url: string): string | null => {
    const m = /[:/]([^/\s:]+)\/([^/\s]+?)(?:\.git)?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : null;
  };

  test.each([
    ['git@github-personal:andrewpopov/smarthome.git', 'andrewpopov/smarthome'],
    ['git@github-work:someorg/repo.git', 'someorg/repo'],
    ['git@github.com:andrewpopov/cairn.git', 'andrewpopov/cairn'],
    ['https://github.com/andrewpopov/bewks.git', 'andrewpopov/bewks'],
    ['https://github.com/andrewpopov/bewks', 'andrewpopov/bewks'],
    ['ssh://git@github.com/andrewpopov/mizen.git', 'andrewpopov/mizen'],
  ])('parses %s', (url, expected) => {
    expect(parse(url)).toBe(expected);
  });

  test('the parser in auto-cut.js is the one under test here', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'auto-cut.js'), 'utf8');
    expect(src).toContain('[:/]([^/\\s:]+)\\/([^/\\s]+?)(?:\\.git)?$');
  });
});

/**
 * PKG-164 review finding 2: deploy.js's merged-only guard fetches the deploy
 * branch with a PLAIN `git fetch <remote> <branch>` and then trusts whatever
 * `git rev-parse <remote>/<branch>` reads back. That silently reads a STALE
 * tracking ref (not an error -- `fetch` still exits 0) whenever the target's
 * configured `remote.<name>.fetch` refspec doesn't map heads to
 * `refs/remotes/<remote>/*` the ordinary-clone way. An explicit destination
 * refspec (`+refs/heads/<branch>:refs/remotes/<remote>/<branch>`) is
 * authoritative regardless of what's configured -- this proves both halves
 * against a REAL git, on a REAL stale-refspec target, not a fake runtime that
 * would accept either command string as equally valid.
 */
describe('merged-only guard fetch: explicit refspec vs a plain fetch (PKG-164 review finding 2)', () => {
  function makeStaleRefspecTarget() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-kit-realgit-refspec-'));
    const originDir = path.join(root, 'origin');
    const targetDir = path.join(root, 'target');
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
    };
    execFileSync('git', ['init', '-q', '-b', 'master', originDir], { encoding: 'utf8' });
    execFileSync('git', ['-C', originDir, 'commit', '-q', '--allow-empty', '-m', 'init'], { encoding: 'utf8', env });
    execFileSync('git', ['clone', '-q', originDir, targetDir], { encoding: 'utf8' });
    // Break the fetch refspec the way a target with a non-default clone/mirror
    // setup would have -- a plain `fetch origin master` afterward still exits
    // 0, but no longer touches refs/remotes/origin/master at all.
    execFileSync('git', ['-C', targetDir, 'config', '--unset-all', 'remote.origin.fetch'], { encoding: 'utf8' });
    execFileSync('git', ['-C', targetDir, 'config', 'remote.origin.fetch',
      '+refs/heads/nonexistent/*:refs/remotes/origin/nonexistent/*'], { encoding: 'utf8' });
    // Advance origin's master AFTER the target's stale tracking ref was set up
    // -- the exact "release PR already merged" ordering the finding describes.
    execFileSync('git', ['-C', originDir, 'commit', '-q', '--allow-empty', '-m', 'second'], { encoding: 'utf8', env });
    const newSha = execFileSync('git', ['-C', originDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    return { root, targetDir, newSha };
  }

  test('a plain `git fetch <remote> <branch>` leaves origin/master STALE under a non-default refspec', () => {
    const { root, targetDir, newSha } = makeStaleRefspecTarget();
    try {
      execFileSync('sh', ['-c', "git fetch 'origin' 'master'"], { cwd: targetDir, encoding: 'utf8' });
      const tip = execFileSync('sh', ['-c', "git rev-parse 'origin'/'master'"], { cwd: targetDir, encoding: 'utf8' }).trim();
      expect(tip).not.toBe(newSha); // stale -- exactly the bug this finding fixes
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('the explicit refspec fetch deploy.js now issues resolves the CURRENT tip, real git, real stale refspec', () => {
    const { root, targetDir, newSha } = makeStaleRefspecTarget();
    try {
      execFileSync('sh', ['-c', "git fetch 'origin' '+refs/heads/master:refs/remotes/origin/master'"], { cwd: targetDir, encoding: 'utf8' });
      const tip = execFileSync('sh', ['-c', "git rev-parse 'origin'/'master'"], { cwd: targetDir, encoding: 'utf8' }).trim();
      expect(tip).toBe(newSha);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('deploy.js issues the explicit-refspec fetch, not the plain one, in the merged-only guard', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'deploy.js'), 'utf8');
    expect(src).toContain('+refs/heads/${branch}:refs/remotes/${config.remote}/${branch}');
  });
});

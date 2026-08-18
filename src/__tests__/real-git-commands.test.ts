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

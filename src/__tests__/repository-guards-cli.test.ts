import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

const roots: string[] = [];
const cli = resolve(__dirname, '../cli.js');

function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-kit-guards-cli-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  writeFileSync(join(root, 'README.md'), '# test\n');
  writeFileSync(join(root, 'cloudflared.yml'), `ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    service: http://127.0.0.1:5173
  - service: http_status:404
`);
  writeFileSync(join(root, 'deploy-kit.guards.json'), JSON.stringify({
    tunnel: {
      configFile: 'cloudflared.yml',
      requiredRules: [{ hostname: 'app.example.com', path: '^/api(/.*)?$', service: 'http://127.0.0.1:3000' }],
      finalService: 'http_status:404',
    },
    secrets: {
      patterns: [{ name: '*.pem', kind: 'basename-suffix', value: '.pem' }],
    },
  }));
  execFileSync('git', ['add', 'README.md', 'cloudflared.yml', 'deploy-kit.guards.json'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  return root;
}

function write(root: string, relativePath: string) {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, 'secret');
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository guard CLI', () => {
  it('runs both guards without requiring a deploy config', () => {
    const root = makeProject();
    const tunnel = spawnSync(process.execPath, [cli, 'verify-tunnel-config', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });
    const secrets = spawnSync(process.execPath, [cli, 'verify-no-secrets', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(tunnel.status).toBe(0);
    expect(JSON.parse(tunnel.stdout)).toMatchObject({ ok: true, checkedRules: 1 });
    expect(secrets.status).toBe(0);
    expect(JSON.parse(secrets.stdout)).toMatchObject({ ok: true, checkedPatterns: 1 });
  });

  it('exits non-zero with actionable JSON for a planted secret-shaped file', () => {
    const root = makeProject();
    write(root, 'private certificate.pem');

    const result = spawnSync(process.execPath, [cli, 'verify-no-secrets', '--json'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      violations: [{ file: 'private certificate.pem', pattern: '*.pem' }],
    });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { verifyTunnelConfig } from '../tunnel-config-guard';

const roots: string[] = [];

function rootWith(contents: string) {
  const root = mkdtempSync(join(tmpdir(), 'deploy-kit-tunnel-guard-'));
  roots.push(root);
  writeFileSync(join(root, 'cloudflared.yml'), contents);
  return root;
}

const policy = {
  configFile: 'cloudflared.yml',
  requiredRules: [
    { path: '^/api(/.*)?$', service: 'http://127.0.0.1:3000' },
    { path: '^/health$', service: 'http://127.0.0.1:3000' },
  ],
  requiredHostnameRules: [
    { hostname: 'ha.example.com', service: 'http://127.0.0.1:8124', allowPath: false },
  ],
  forbiddenServiceIncludes: [':8123'],
  finalService: 'http_status:404',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verifyTunnelConfig', () => {
  it('accepts configured anchored routes before catch-all rules', () => {
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    service: http://127.0.0.1:5173
  - hostname: ha.example.com
    service: http://127.0.0.1:8124
  - service: http_status:404
`);

    expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('fails by name when a required route is shadowed by the SPA catch-all', () => {
    const root = rootWith(`ingress:
  - hostname: app.example.com
    service: http://127.0.0.1:5173
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: ha.example.com
    service: http://127.0.0.1:8124
  - service: http_status:404
`);

    const result = verifyTunnelConfig({ projectRoot: root, policy });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      '^/api(/.*)?$ is listed after a rule that matches every path',
    );
  });

  it('reports unanchored paths, wrong services, and forbidden direct origins', () => {
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: /api/*
    service: http://127.0.0.1:5173
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:5173
  - hostname: ha.example.com
    path: ^/lovelace$
    service: http://127.0.0.1:8123
  - service: http_status:500
`);

    const result = verifyTunnelConfig({ projectRoot: root, policy });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('no ingress rule for required path ^/api(/.*)?$');
    expect(result.errors.join('\n')).toContain('^/health$ must route to http://127.0.0.1:3000');
    expect(result.errors.join('\n')).toContain('ha.example.com must route to http://127.0.0.1:8124');
    expect(result.errors.join('\n')).toContain('ingress service must not include :8123');
    expect(result.errors.join('\n')).toContain('path `/api/*` is unanchored');
    expect(result.errors.join('\n')).toContain('final rule must use service http_status:404');
  });
});

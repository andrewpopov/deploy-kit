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
    { hostname: 'app.example.com', path: '^/api(/.*)?$', service: 'http://127.0.0.1:3000' },
    { hostname: 'app.example.com', path: '^/health$', service: 'http://127.0.0.1:3000' },
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
    expect(result.errors.join('\n')).toContain(
      'no ingress rule for required hostname app.example.com path ^/api(/.*)?$',
    );
    expect(result.errors.join('\n')).toContain('app.example.com ^/health$ must route to http://127.0.0.1:3000');
    expect(result.errors.join('\n')).toContain('ha.example.com must route to http://127.0.0.1:8124');
    expect(result.errors.join('\n')).toContain('ingress service must not include :8123');
    expect(result.errors.join('\n')).toContain('path `/api/*` is unanchored');
    expect(result.errors.join('\n')).toContain('final rule must use service http_status:404');
  });

  it('rejects a requiredRules entry missing hostname', () => {
    const root = rootWith('ingress:\n  - service: http_status:404\n');
    const badPolicy = {
      ...policy,
      requiredRules: [{ path: '^/api(/.*)?$', service: 'http://127.0.0.1:3000' }],
    };

    expect(() => verifyTunnelConfig({ projectRoot: root, policy: badPolicy })).toThrow(
      'tunnel.requiredRules[0] must define string hostname, path, and service values',
    );
  });

  it('does not flag a required path shadowed only by a catch-all on a DIFFERENT host', () => {
    const root = rootWith(`ingress:
  - hostname: ha.example.com
    service: http://127.0.0.1:8124
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    service: http://127.0.0.1:5173
  - service: http_status:404
`);

    expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('flags a required path shadowed by a global (hostless) catch-all', () => {
    const root = rootWith(`ingress:
  - service: http://127.0.0.1:9000
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
    expect(result.errors).toContain('^/api(/.*)?$ is listed after a rule that matches every path');
    expect(result.errors).toContain('^/health$ is listed after a rule that matches every path');
  });

  it('flags a required path shadowed by a SAME-host catch-all', () => {
    // The pre-existing "shadowed by the SPA catch-all" fixture above already
    // proves this (app.example.com's own catch-all sits before its /api and
    // /health rules); this test names the same-host case explicitly as a
    // canary alongside the different-host and global cases.
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
    expect(result.errors).toContain('^/api(/.*)?$ is listed after a rule that matches every path');
    expect(result.errors).toContain('^/health$ is listed after a rule that matches every path');
  });

  it('does not let a same-path rule on the WRONG host satisfy a host-scoped required rule', () => {
    // The wrong-host duplicate is listed first, so a path-only match would
    // find it before ever reaching the correct-host rule below it.
    const root = rootWith(`ingress:
  - hostname: wrong.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:9999
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

    expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('rejects a hostless same-path rule as satisfying a host-scoped required rule', () => {
    const root = rootWith(`ingress:
  - path: ^/api(/.*)?$
    service: http://127.0.0.1:9999
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
      'no ingress rule for required hostname app.example.com path ^/api(/.*)?$',
    );
  });

  it('treats an empty or whitespace-only hostname as missing on a requiredRules entry', () => {
    const root = rootWith('ingress:\n  - service: http_status:404\n');
    const badPolicy = {
      ...policy,
      requiredRules: [{ hostname: '   ', path: '^/api(/.*)?$', service: 'http://127.0.0.1:3000' }],
    };

    expect(() => verifyTunnelConfig({ projectRoot: root, policy: badPolicy })).toThrow(
      'tunnel.requiredRules[0] must define string hostname, path, and service values',
    );
  });

  it('treats an empty or whitespace-only hostname as missing on a requiredHostnameRules entry', () => {
    const root = rootWith('ingress:\n  - service: http_status:404\n');
    const badPolicy = {
      ...policy,
      requiredHostnameRules: [{ hostname: '', service: 'http://127.0.0.1:8124' }],
    };

    expect(() => verifyTunnelConfig({ projectRoot: root, policy: badPolicy })).toThrow(
      'each tunnel.requiredHostnameRules entry must define hostname and service strings',
    );
  });
});

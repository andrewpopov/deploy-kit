import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hostnameMatches, verifyTunnelConfig } from '../tunnel-config-guard';

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

  it('fails by shadowing when a `*.example.com` catch-all precedes the exact required API route', () => {
    const root = rootWith(`ingress:
  - hostname: '*.example.com'
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

  it('does not flag an unrelated `*.other.com` catch-all ahead of the required routes', () => {
    const root = rootWith(`ingress:
  - hostname: '*.other.com'
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

    expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('accepts a wildcard-hosted path rule as satisfying an exact-host required route (documented support)', () => {
    // No requiredHostnameRules here on purpose: `*.example.com` also covers
    // ha.example.com, which would otherwise collide with the base policy's
    // separate ha.example.com requiredHostnameRules entry below.
    const wildcardPolicy = {
      configFile: 'cloudflared.yml',
      requiredRules: policy.requiredRules,
      forbiddenServiceIncludes: policy.forbiddenServiceIncludes,
      finalService: policy.finalService,
    };
    const root = rootWith(`ingress:
  - hostname: '*.example.com'
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - service: http_status:404
`);

    expect(verifyTunnelConfig({ projectRoot: root, policy: wildcardPolicy })).toMatchObject({
      ok: true,
      checkedRules: 2,
      errors: [],
    });
  });

  it('fails requiredHostnameRules when an earlier global catch-all shadows the exact-host rule', () => {
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
    expect(result.errors).toContain('ha.example.com is shadowed by an earlier rule that matches every path');
  });

  it('fails by shadowing when a bare `*` catch-all precedes a required route', () => {
    const root = rootWith(`ingress:
  - hostname: '*'
    path: ^.*$
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

  it('does not shadow when a bare `*` rule has a non-catch-all path ahead of the required routes', () => {
    const root = rootWith(`ingress:
  - hostname: '*'
    path: ^/only-this$
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

    expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('does not shadow when a bare `*` catch-all is listed after the required routes', () => {
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: ha.example.com
    service: http://127.0.0.1:8124
  - hostname: '*'
    path: ^.*$
    service: http://127.0.0.1:5173
  - service: http_status:404
`);

    expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('does not let a bare `*` rule satisfy a host-scoped requiredRules entry', () => {
    const root = rootWith(`ingress:
  - hostname: '*'
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
      'no ingress rule for required hostname app.example.com path ^/api(/.*)?$',
    );
  });

  it('does not let a bare `*` rule satisfy a requiredHostnameRules entry', () => {
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: '*'
    path: ^/other$
    service: http://127.0.0.1:8124
  - service: http_status:404
`);

    const result = verifyTunnelConfig({ projectRoot: root, policy });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('ha.example.com must have an ingress rule');
  });

  it('passes requiredHostnameRules when an exact rule precedes a later matching wildcard fallback', () => {
    const wildcardPolicy = {
      configFile: 'cloudflared.yml',
      requiredRules: policy.requiredRules,
      requiredHostnameRules: policy.requiredHostnameRules,
      finalService: policy.finalService,
    };
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: ha.example.com
    service: http://127.0.0.1:8124
  - hostname: '*.example.com'
    service: http://127.0.0.1:9999
  - service: http_status:404
`);

    expect(verifyTunnelConfig({ projectRoot: root, policy: wildcardPolicy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  it('fails by name when a wildcard fallback precedes the exact rule and is the effective (wrong-service) rule', () => {
    const wildcardPolicy = {
      configFile: 'cloudflared.yml',
      requiredRules: policy.requiredRules,
      requiredHostnameRules: policy.requiredHostnameRules,
      finalService: policy.finalService,
    };
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: '*.example.com'
    service: http://127.0.0.1:9999
  - hostname: ha.example.com
    service: http://127.0.0.1:8124
  - service: http_status:404
`);

    const result = verifyTunnelConfig({ projectRoot: root, policy: wildcardPolicy });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('ha.example.com must route to http://127.0.0.1:8124, found: http://127.0.0.1:9999');
  });

  it('passes requiredHostnameRules when the effective wildcard-first rule itself meets policy', () => {
    const wildcardPolicy = {
      configFile: 'cloudflared.yml',
      requiredRules: policy.requiredRules,
      requiredHostnameRules: policy.requiredHostnameRules,
      finalService: policy.finalService,
    };
    const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ^/api(/.*)?$
    service: http://127.0.0.1:3000
  - hostname: app.example.com
    path: ^/health$
    service: http://127.0.0.1:3000
  - hostname: '*.example.com'
    service: http://127.0.0.1:8124
  - hostname: ha.example.com
    service: http://127.0.0.1:9999
  - service: http_status:404
`);

    expect(verifyTunnelConfig({ projectRoot: root, policy: wildcardPolicy })).toMatchObject({
      ok: true,
      checkedRules: 3,
      errors: [],
    });
  });

  for (const [name, path] of [
    ['^(.*)$', '^(.*)$'],
    ['^.+$', '^.+$'],
    ['^(.+)$', '^(.+)$'],
  ]) {
    it(`fails by shadowing when a catch-all rule spelled \`${name}\` precedes a required route`, () => {
      const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ${path}
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
  }

  for (const [name, path] of [
    ['^.+/foo$', '^.+/foo$'],
    ['^(.+)\\.html$', '^(.+)\\.html$'],
  ]) {
    it(`does not treat the similar but non-universal path \`${name}\` as a catch-all`, () => {
      const root = rootWith(`ingress:
  - hostname: app.example.com
    path: ${path}
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

      expect(verifyTunnelConfig({ projectRoot: root, policy })).toMatchObject({
        ok: true,
        checkedRules: 3,
        errors: [],
      });
    });
  }
});

describe('hostnameMatches', () => {
  it('matches an exact hostname against itself', () => {
    expect(hostnameMatches('app.example.com', 'app.example.com')).toBe(true);
  });

  it('matches one or more subdomain labels under a wildcard', () => {
    expect(hostnameMatches('*.example.com', 'app.example.com')).toBe(true);
    expect(hostnameMatches('*.example.com', 'deep.app.example.com')).toBe(true);
  });

  it('does not match the apex domain against its own wildcard', () => {
    expect(hostnameMatches('*.example.com', 'example.com')).toBe(false);
  });

  it('does not match an unrelated suffix', () => {
    expect(hostnameMatches('*.example.com', 'evilexample.com')).toBe(false);
    expect(hostnameMatches('*.example.com', 'app.other.com')).toBe(false);
  });

  it('matches an exact hostname case-insensitively', () => {
    expect(hostnameMatches('APP.EXAMPLE.COM', 'app.example.com')).toBe(true);
  });

  it('does not normalize a trailing dot', () => {
    expect(hostnameMatches('APP.EXAMPLE.COM.', 'app.example.com')).toBe(false);
  });

  it('matches wildcard prefix and suffix case-sensitively', () => {
    expect(hostnameMatches('*.Example.com', 'deep.example.com')).toBe(false);
    expect(hostnameMatches('*.example.com', 'deep.example.com')).toBe(true);
  });

  it('treats a bare `*` hostname as never an explicit match, even against itself', () => {
    expect(hostnameMatches('*', 'app.example.com')).toBe(false);
    expect(hostnameMatches('*', '*')).toBe(false);
  });
});

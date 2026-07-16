import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { runHostOperations, runCairnOperations } = require('../host-operations.js');

function response(status: number, data?: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => ({ data }) };
}

describe('generic host operation runner', () => {
  it('honors an injected action and base URL, runs configured deploy, and completes the lease', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = async (url: string, options: { body?: string }) => {
      calls.push({ url, body: options.body });
      if (url.endsWith('/claim')) return response(200, { id: 'request-1', action: 'DEPLOY_STAGING', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, { id: 'request-1', status: 'SUCCEEDED' });
    };
    let deployed = false;
    const result = await runHostOperations({ mode: 'local' }, {
      action: 'DEPLOY_STAGING',
      apiUrl: 'https://host-ops.test/api',
      apiKey: 'host-key',
      fetchImpl,
      deployFn: () => { deployed = true; },
      log: {},
    });
    expect(result).toEqual({ state: 'succeeded', id: 'request-1' });
    expect(deployed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://host-ops.test/api/operations/requests/claim');
    // The claim carries the configured action so a filtering server never
    // leases this runner a request meant for another action.
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({ action: 'DEPLOY_STAGING' });
    expect(calls[1].url).toBe('https://host-ops.test/api/operations/requests/request-1/complete');
    expect(JSON.parse(calls[1].body ?? '{}')).toMatchObject({ status: 'SUCCEEDED', resultSummary: 'Configured deployment completed' });
  });

  it('rejects a mismatched claimed action, completing the lease as FAILED before throwing', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    let deployed = false;
    const fetchImpl = async (url: string, options: { body?: string }) => {
      calls.push({ url, body: options.body });
      if (url.endsWith('/claim')) return response(200, { id: 'request-1', action: 'DEPLOY_CAIRN_PRODUCTION', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, { id: 'request-1', status: 'FAILED' });
    };
    await expect(runHostOperations({}, {
      action: 'DEPLOY_STAGING', apiUrl: 'https://host-ops.test/api', apiKey: 'host-key', fetchImpl, deployFn: () => { deployed = true; }, log: {},
    })).rejects.toThrow('Host operations API returned an unsupported operation request');
    expect(deployed).toBe(false);
    // The mistakenly claimed lease is released as FAILED, not abandoned.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://host-ops.test/api/operations/requests/request-1/complete');
    expect(JSON.parse(calls[1].body ?? '{}')).toMatchObject({
      leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz', status: 'FAILED', resultSummary: 'unsupported action for this runner',
    });
  });

  it('still throws on a mismatch even when releasing the lease fails, logging the completion error', async () => {
    const errors: string[] = [];
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/claim')) return response(200, { id: 'request-1', action: 'DEPLOY_CAIRN_PRODUCTION', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(500);
    };
    await expect(runHostOperations({}, {
      action: 'DEPLOY_STAGING', apiUrl: 'https://host-ops.test/api', apiKey: 'host-key', fetchImpl, log: { error: (m: string) => errors.push(m) },
    })).rejects.toThrow('Host operations API returned an unsupported operation request');
    expect(errors).toEqual(['Host operation request failed (HTTP 500)']);
  });

  it('requires action, apiUrl, and apiKey with generic labels', async () => {
    const fetchImpl = async () => response(204);
    await expect(runHostOperations({}, { apiUrl: 'x', apiKey: 'y', fetchImpl })).rejects.toThrow('action is required');
    await expect(runHostOperations({}, { action: 'A', apiKey: 'y', fetchImpl })).rejects.toThrow('apiUrl is required');
    await expect(runHostOperations({}, { action: 'A', apiUrl: 'x', fetchImpl })).rejects.toThrow('apiKey is required');
  });

  it('reports request failures with generic wording', async () => {
    const fetchImpl = async () => response(500);
    await expect(runHostOperations({}, { action: 'A', apiUrl: 'https://host-ops.test/api', apiKey: 'k', fetchImpl, log: {} }))
      .rejects.toThrow('Host operation request failed (HTTP 500)');
  });

  it('reports a generic failure through the lease and rethrows the deploy failure', async () => {
    const bodies: string[] = [];
    const fetchImpl = async (url: string, options: { body?: string }) => {
      if (options.body) bodies.push(options.body);
      if (url.endsWith('/claim')) return response(200, { id: 'request-2', action: 'DEPLOY_STAGING', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, { id: 'request-2', status: 'FAILED' });
    };
    await expect(runHostOperations({}, {
      action: 'DEPLOY_STAGING', apiUrl: 'https://host-ops.test/api', apiKey: 'host-key', fetchImpl, deployFn: () => { throw new Error('private deployment detail'); }, log: {},
    })).rejects.toThrow('private deployment detail');
    expect(JSON.stringify(bodies)).not.toContain('private deployment detail');
    expect(JSON.parse(bodies[bodies.length - 1])).toMatchObject({ status: 'FAILED', resultSummary: 'Configured deployment failed' });
  });
});

describe('deprecated runCairnOperations wrapper', () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it('still claims only the fixed Cairn deploy action, runs configured deploy, and completes the lease', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = async (url: string, options: { body?: string }) => {
      calls.push({ url, body: options.body });
      if (url.endsWith('/claim')) return response(200, { id: 'request-1', action: 'DEPLOY_CAIRN_PRODUCTION', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, { id: 'request-1', status: 'SUCCEEDED' });
    };
    let deployed = false;
    const result = await runCairnOperations({ mode: 'local' }, { apiUrl: 'https://cairn.test/api', apiKey: 'host-key', fetchImpl, deployFn: () => { deployed = true; }, log: {} });
    expect(result).toEqual({ state: 'succeeded', id: 'request-1' });
    expect(deployed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe('https://cairn.test/api/operations/requests/request-1/complete');
    expect(JSON.parse(calls[1].body ?? '{}')).toMatchObject({ status: 'SUCCEEDED', resultSummary: 'Configured deployment completed' });
  });

  it('still reports a generic failure through the lease and rethrows the deploy failure', async () => {
    const bodies: string[] = [];
    const fetchImpl = async (url: string, options: { body?: string }) => {
      if (options.body) bodies.push(options.body);
      if (url.endsWith('/claim')) return response(200, { id: 'request-2', action: 'DEPLOY_CAIRN_PRODUCTION', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, { id: 'request-2', status: 'FAILED' });
    };
    await expect(runCairnOperations({}, { apiUrl: 'https://cairn.test/api', apiKey: 'host-key', fetchImpl, deployFn: () => { throw new Error('private deployment detail'); }, log: {} })).rejects.toThrow('private deployment detail');
    expect(JSON.stringify(bodies)).not.toContain('private deployment detail');
    expect(JSON.parse(bodies[bodies.length - 1])).toMatchObject({ status: 'FAILED', resultSummary: 'Configured deployment failed' });
  });

  it('reproduces the original observable error messages exactly', async () => {
    // Ensure the wrapper's env-var defaults cannot mask the missing-option paths.
    vi.stubEnv('CAIRN_OPERATIONS_API_URL', '');
    vi.stubEnv('CAIRN_OPERATIONS_API_KEY', '');
    const fetchImpl204 = async () => response(204);
    await expect(runCairnOperations({}, { apiUrl: undefined, apiKey: 'k', fetchImpl: fetchImpl204, log: {} }))
      .rejects.toThrow('CAIRN_OPERATIONS_API_URL is required');
    await expect(runCairnOperations({}, { apiUrl: 'https://cairn.test/api', apiKey: undefined, fetchImpl: fetchImpl204, log: {} }))
      .rejects.toThrow('CAIRN_OPERATIONS_API_KEY is required');
    const fetchImpl500 = async () => response(500);
    await expect(runCairnOperations({}, { apiUrl: 'https://cairn.test/api', apiKey: 'k', fetchImpl: fetchImpl500, log: {} }))
      .rejects.toThrow('Cairn operation request failed (HTTP 500)');
    const fetchImplMismatch = async (url: string) => {
      if (url.endsWith('/claim')) return response(200, { id: 'request-1', action: 'SOMETHING_ELSE', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, {});
    };
    await expect(runCairnOperations({}, { apiUrl: 'https://cairn.test/api', apiKey: 'k', fetchImpl: fetchImplMismatch, log: {} }))
      .rejects.toThrow('Cairn returned an unsupported operation request');
  });
});

describe('cli wiring', () => {
  const cli = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
  const os = require('os');
  const fs = require('fs');
  const path = require('path');

  function inTmpDir(fn: (dir: string) => void) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-hostops-'));
    try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  it('run-host-operations requires --action', () => {
    inTmpDir((dir) => {
      expect(cli.run(['run-host-operations'], { cwd: dir, env: {} })).toBe(1);
    });
  });

  it('run-cairn-operations rejects the new generic flags instead of silently ignoring them', () => {
    inTmpDir((dir) => {
      // Must fail synchronously (before any API/env resolution) — a silently
      // ignored flag is the BWK-136 failure mode.
      expect(cli.run(['run-cairn-operations', '--action', 'DEPLOY_STAGING'], { cwd: dir, env: {} })).toBe(1);
      expect(cli.run(['run-cairn-operations', '--api-url-env', 'X'], { cwd: dir, env: {} })).toBe(1);
      expect(cli.run(['run-cairn-operations', '--api-key-env', 'X'], { cwd: dir, env: {} })).toBe(1);
    });
  });

  it('run-cairn-operations without flags still reaches the runner (fails on missing env, asynchronously)', async () => {
    await new Promise<void>((resolve) => {
      inTmpDir(async (dir) => {
        const result = cli.run(['run-cairn-operations'], { cwd: dir, env: {} });
        expect(result).toBeInstanceOf(Promise);
        expect(await result).toBe(1); // CAIRN_OPERATIONS_API_URL is required
        resolve();
      });
    });
  });
});

import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(__filename);
const { runCairnOperations } = require('../cairn-operations.js');

function response(status: number, data?: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => ({ data }) };
}

describe('Cairn operation runner', () => {
  it('claims only the fixed deploy action, runs configured deploy, and completes the lease', async () => {
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

  it('reports a generic failure through the lease and rethrows the deploy failure', async () => {
    const bodies: string[] = [];
    const fetchImpl = async (url: string, options: { body?: string }) => {
      if (options.body) bodies.push(options.body);
      if (url.endsWith('/claim')) return response(200, { id: 'request-2', action: 'DEPLOY_CAIRN_PRODUCTION', leaseToken: 'lease-token-abcdefghijklmnopqrstuvwxyz' });
      return response(200, { id: 'request-2', status: 'FAILED' });
    };
    await expect(runCairnOperations({}, { apiUrl: 'https://cairn.test/api', apiKey: 'host-key', fetchImpl, deployFn: () => { throw new Error('private deployment detail'); }, log: {} })).rejects.toThrow('private deployment detail');
    expect(JSON.stringify(bodies)).not.toContain('private deployment detail');
    expect(JSON.parse(bodies[0])).toMatchObject({ status: 'FAILED', resultSummary: 'Configured deployment failed' });
  });
});

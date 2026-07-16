'use strict';

const { deploy } = require('./deploy');

const DEPLOY_ACTION = 'DEPLOY_CAIRN_PRODUCTION';

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function request(fetchImpl, url, key, path, body) {
  const response = await fetchImpl(`${url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`Cairn operation request failed (HTTP ${response.status})`);
  const parsed = await response.json();
  return parsed.data;
}

// Claim exactly one allowlisted request, execute the already-configured deploy
// pipeline, then report the terminal state. No remote command, host, path, or
// deploy options are accepted from Cairn.
async function runCairnOperations(config, {
  apiUrl = process.env.CAIRN_OPERATIONS_API_URL,
  apiKey = process.env.CAIRN_OPERATIONS_API_KEY,
  fetchImpl = globalThis.fetch,
  deployFn = deploy,
  log = console,
} = {}) {
  required(fetchImpl, 'fetch implementation');
  const url = required(apiUrl, 'CAIRN_OPERATIONS_API_URL');
  const key = required(apiKey, 'CAIRN_OPERATIONS_API_KEY');
  const claimed = await request(fetchImpl, url, key, '/operations/requests/claim');
  if (!claimed) return { state: 'idle' };
  if (claimed.action !== DEPLOY_ACTION || typeof claimed.id !== 'string' || typeof claimed.leaseToken !== 'string') {
    throw new Error('Cairn returned an unsupported operation request');
  }
  try {
    deployFn(config, {});
    await request(fetchImpl, url, key, `/operations/requests/${claimed.id}/complete`, {
      leaseToken: claimed.leaseToken, status: 'SUCCEEDED', resultSummary: 'Configured deployment completed',
    });
    log.info?.(`Cairn operation ${claimed.id} completed`);
    return { state: 'succeeded', id: claimed.id };
  } catch (error) {
    try {
      await request(fetchImpl, url, key, `/operations/requests/${claimed.id}/complete`, {
        leaseToken: claimed.leaseToken, status: 'FAILED', resultSummary: 'Configured deployment failed',
      });
    } catch (completionError) {
      log.error?.(completionError instanceof Error ? completionError.message : String(completionError));
    }
    throw error;
  }
}

module.exports = { DEPLOY_ACTION, runCairnOperations };

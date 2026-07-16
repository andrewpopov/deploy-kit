'use strict';

const { deploy } = require('./deploy');

// Retained for backward compatibility: the action name Cairn's operations API
// used before this runner became host-configurable.
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
  if (!response.ok) throw new Error(`Host operation request failed (HTTP ${response.status})`);
  const parsed = await response.json();
  return parsed.data;
}

// Claim exactly one allowlisted request, execute the already-configured deploy
// pipeline, then report the terminal state. No remote command, host, path, or
// deploy options are accepted from the operations API.
async function runHostOperations(config, {
  action,
  apiUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  deployFn = deploy,
  log = console,
} = {}) {
  required(fetchImpl, 'fetch implementation');
  const configuredAction = required(action, 'action');
  const url = required(apiUrl, 'apiUrl');
  const key = required(apiKey, 'apiKey');
  const claimed = await request(fetchImpl, url, key, '/operations/requests/claim');
  if (!claimed) return { state: 'idle' };
  if (claimed.action !== configuredAction || typeof claimed.id !== 'string' || typeof claimed.leaseToken !== 'string') {
    throw new Error('Host operations API returned an unsupported operation request');
  }
  try {
    deployFn(config, {});
    await request(fetchImpl, url, key, `/operations/requests/${claimed.id}/complete`, {
      leaseToken: claimed.leaseToken, status: 'SUCCEEDED', resultSummary: 'Configured deployment completed',
    });
    log.info?.(`Host operation ${claimed.id} completed`);
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

/**
 * @deprecated Use `runHostOperations` with an explicit `action`, `apiUrl`, and
 * `apiKey`. Kept so existing Cairn consumers keep working unchanged: it
 * supplies the old fixed action name and the old `CAIRN_OPERATIONS_API_URL` /
 * `CAIRN_OPERATIONS_API_KEY` env var defaults.
 */
async function runCairnOperations(config, {
  apiUrl = process.env.CAIRN_OPERATIONS_API_URL,
  apiKey = process.env.CAIRN_OPERATIONS_API_KEY,
  fetchImpl = globalThis.fetch,
  deployFn = deploy,
  log = console,
} = {}) {
  return runHostOperations(config, {
    action: DEPLOY_ACTION, apiUrl, apiKey, fetchImpl, deployFn, log,
  });
}

module.exports = { DEPLOY_ACTION, runHostOperations, runCairnOperations };

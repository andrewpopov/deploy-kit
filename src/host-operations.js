'use strict';

const { deploy } = require('./deploy');

// Retained for backward compatibility: the action name Cairn's operations API
// used before this runner became host-configurable.
const DEPLOY_ACTION = 'DEPLOY_CAIRN_PRODUCTION';

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function request(fetchImpl, url, key, path, body, failureLabel) {
  const response = await fetchImpl(`${url.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`${failureLabel} (HTTP ${response.status})`);
  const parsed = await response.json();
  return parsed.data;
}

// Claim exactly one allowlisted request, execute the already-configured deploy
// pipeline, then report the terminal state. No remote command, host, path, or
// deploy options are accepted from the operations API.
//
// `labels` exists only so the deprecated Cairn wrapper can reproduce its
// original observable error messages exactly; generic callers never pass it.
async function runHostOperations(config, {
  action,
  apiUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
  deployFn = deploy,
  log = console,
  labels = {},
} = {}) {
  const {
    apiUrl: apiUrlLabel = 'apiUrl',
    apiKey: apiKeyLabel = 'apiKey',
    requestFailure: requestFailureLabel = 'Host operation request failed',
    unsupportedRequest: unsupportedRequestLabel = 'Host operations API returned an unsupported operation request',
  } = labels;
  required(fetchImpl, 'fetch implementation');
  const configuredAction = required(action, 'action');
  const url = required(apiUrl, apiUrlLabel);
  const key = required(apiKey, apiKeyLabel);
  // Send the configured action with the claim so a filtering server never
  // leases this runner a request meant for another action. A server that
  // ignores the body is no worse off — the post-claim check below stays as
  // defense-in-depth.
  const claimed = await request(fetchImpl, url, key, '/operations/requests/claim', { action: configuredAction }, requestFailureLabel);
  if (!claimed) return { state: 'idle' };
  if (claimed.action !== configuredAction || typeof claimed.id !== 'string' || typeof claimed.leaseToken !== 'string') {
    // Best-effort: release a mistakenly claimed lease as FAILED rather than
    // abandoning it until lease expiry. Only possible when the claim carried
    // a usable id + leaseToken.
    if (typeof claimed.id === 'string' && typeof claimed.leaseToken === 'string') {
      try {
        await request(fetchImpl, url, key, `/operations/requests/${claimed.id}/complete`, {
          leaseToken: claimed.leaseToken, status: 'FAILED', resultSummary: 'unsupported action for this runner',
        }, requestFailureLabel);
      } catch (completionError) {
        log.error?.(completionError instanceof Error ? completionError.message : String(completionError));
      }
    }
    throw new Error(unsupportedRequestLabel);
  }
  try {
    deployFn(config, {});
    await request(fetchImpl, url, key, `/operations/requests/${claimed.id}/complete`, {
      leaseToken: claimed.leaseToken, status: 'SUCCEEDED', resultSummary: 'Configured deployment completed',
    }, requestFailureLabel);
    log.info?.(`Host operation ${claimed.id} completed`);
    return { state: 'succeeded', id: claimed.id };
  } catch (error) {
    try {
      await request(fetchImpl, url, key, `/operations/requests/${claimed.id}/complete`, {
        leaseToken: claimed.leaseToken, status: 'FAILED', resultSummary: 'Configured deployment failed',
      }, requestFailureLabel);
    } catch (completionError) {
      log.error?.(completionError instanceof Error ? completionError.message : String(completionError));
    }
    throw error;
  }
}

/**
 * @deprecated Use `runHostOperations` with an explicit `action`, `apiUrl`, and
 * `apiKey`. Kept so existing Cairn consumers keep working unchanged: it
 * supplies the old fixed action name, the old `CAIRN_OPERATIONS_API_URL` /
 * `CAIRN_OPERATIONS_API_KEY` env var defaults, and the original error wording.
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
    labels: {
      apiUrl: 'CAIRN_OPERATIONS_API_URL',
      apiKey: 'CAIRN_OPERATIONS_API_KEY',
      requestFailure: 'Cairn operation request failed',
      unsupportedRequest: 'Cairn returned an unsupported operation request',
    },
  });
}

module.exports = { DEPLOY_ACTION, runHostOperations, runCairnOperations };

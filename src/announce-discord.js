'use strict';

// A bundled, OPT-IN convenience deliveryEvent.command that posts a RELEASE
// announcement to a per-app Discord channel after a successful deploy: the
// release counterpart to alert-discord.js's incident sink.
//
// This is NOT part of the policy-free delivery-event contract — deploy.js and
// release.js remain unaware Discord exists. This module just happens to
// implement the same stdin-JSON contract any consumer-provided
// `deliveryEvent.command` must: read the deployment event JSON on stdin, do
// something with it, exit 0. A config wires it up like any other sink:
//   deliveryEvent: { command: "npx deploy-kit announce-discord" }
// Swapping it for a different sink (Slack, a shell one-liner) requires no
// change to deploy.js/release.js — that is the point of the policy-free core.

const DEFAULT_WEBHOOK_ENV = 'DISCORD_RELEASE_WEBHOOK';
const DEFAULT_SERVICE = 'app';
const POST_TIMEOUT_MS = 10000;

// Redact a secret value out of any string before it is logged. The webhook URL
// must NEVER be printed — not in a success message, not in an error, not in a
// thrown exception's message (some fetch implementations echo the request URL).
function redact(message, secret) {
  if (!secret) return message;
  return String(message).split(secret).join('[redacted webhook URL]');
}

// Format the deploy delivery event ({ event: 'deployment', status: 'succeeded',
// branch, revision, deployedAt } — see deploy.js/release.js's `deliveryEvent`
// emission) into a concise Discord release announcement.
function formatDiscordMessage(event, { service = DEFAULT_SERVICE } = {}) {
  const branch = (event && event.branch) || 'unknown-branch';
  const revision = (event && event.revision) || '';
  const shortSha = revision ? revision.slice(0, 7) : 'unknown';
  const deployedAt = (event && event.deployedAt) || new Date().toISOString();
  const when = formatTimestamp(deployedAt);
  return `🚀 \`${service}\` deployed \`${branch}@${shortSha}\` at ${when}`;
}

// Render an ISO timestamp readably; fall back to the raw string if it does not
// parse (a malformed/missing deployedAt must never crash formatting).
function formatTimestamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

// POST the message to the Discord webhook, bounded by a short timeout so a hung
// network call can never wedge a deploy. `fetchImpl` is the injection seam —
// tests supply a fake so no real network call is ever made.
async function postToDiscord(webhookUrl, content, { fetchImpl, timeoutMs = POST_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });
    return { ok: !!(res && res.ok), status: res && res.status };
  } finally {
    clearTimeout(timer);
  }
}

// Entry point shared by the CLI: read the delivery-event JSON already collected
// from stdin, resolve the webhook URL, format + POST.
//
// KEY ASYMMETRY vs alert-discord: a release announcement is opt-in decoration
// on top of an ALREADY-TOLERATED deliveryEvent step (deploy.js/release.js run
// `deliveryEvent.command` with `tolerate: true`), whereas alert-discord IS the
// monitor's alert route — a missing alert sink is itself the incident. So here:
//   - unset webhook env  -> SKIP (exit 0), not a failure: a healthy deploy must
//     never go red because nobody wired up a Discord channel yet.
//   - malformed stdin JSON -> WARN (exit 0): a broken announcement must never
//     fail a deploy that already succeeded.
//   - non-2xx / timeout    -> WARN (exit 0), same reasoning.
// alert-discord instead exits 1 for every one of these, because there a
// missing/broken route IS the problem it exists to report.
async function announceDiscord({
  stdin, webhookEnvName = DEFAULT_WEBHOOK_ENV, service, env = process.env, fetchImpl, log,
}) {
  const webhookUrl = env[webhookEnvName];
  if (!webhookUrl) {
    log.warning(`announce-discord: ${webhookEnvName} not set — skipping release announcement`);
    return 0;
  }

  const resolvedService = service || env.DISCORD_RELEASE_SERVICE || env.DISCORD_ALERT_SERVICE || DEFAULT_SERVICE;

  let event;
  try {
    event = JSON.parse(stdin);
  } catch (error) {
    log.warning(`announce-discord: malformed delivery-event JSON on stdin (${error.message}) — skipping release announcement`);
    return 0;
  }

  const content = formatDiscordMessage(event, { service: resolvedService });
  try {
    const result = await postToDiscord(webhookUrl, content, { fetchImpl });
    if (result.ok) {
      log.success(`announce-discord: posted release announcement to Discord (HTTP ${result.status})`);
      return 0;
    }
    log.warning(`announce-discord: Discord POST failed (HTTP ${result.status}) — release announcement skipped`);
    return 0;
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timed out' : (error && error.message) || String(error);
    log.warning(`announce-discord: Discord POST failed (${redact(reason, webhookUrl)}) — release announcement skipped`);
    return 0;
  }
}

module.exports = {
  DEFAULT_WEBHOOK_ENV, DEFAULT_SERVICE, formatDiscordMessage, postToDiscord, announceDiscord,
};

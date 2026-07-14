'use strict';

// A bundled, OPT-IN convenience alert.command for deploy-kit's monitor: posts the
// alert JSON monitor.js pipes to alert.command as a formatted Discord message.
//
// This is NOT part of the policy-free monitor contract — monitor.js and checks.js
// remain unaware Discord exists. This module just happens to implement the same
// stdin-JSON contract any consumer-provided `alert.command` must: read the batched
// event JSON on stdin, do something with it, exit 0 on success. A config wires it
// up like any other alert sink:
//   monitor: { alert: { command: "npx deploy-kit alert-discord" } }
// Swapping it for a different sink (Slack, PagerDuty, a shell one-liner) requires
// no change to monitor.js/checks.js — that is the point of the policy-free core.

const DEFAULT_WEBHOOK_ENV = 'DISCORD_ALERT_WEBHOOK';
const POST_TIMEOUT_MS = 10000;

// Redact a secret value out of any string before it is logged. The webhook URL
// must NEVER be printed — not in a success message, not in an error, not in a
// thrown exception's message (some fetch implementations echo the request URL).
function redact(message, secret) {
  if (!secret) return message;
  return String(message).split(secret).join('[redacted webhook URL]');
}

// Format the monitor event ({ eventId, createdAtMs, host, alerts: [{id,kind,status,
// message}] } — see monitor.js `deliverAlert`) into a concise Discord message body.
// kind is one of alert|escalation|reminder (still failing) or recovery (back to ok).
function formatDiscordMessage(event) {
  const host = (event && event.host) || 'unknown-host';
  const alerts = Array.isArray(event && event.alerts) ? event.alerts : [];
  const failing = alerts.filter((a) => a && a.kind !== 'recovery');
  const recovered = alerts.filter((a) => a && a.kind === 'recovery');

  const title = failing.length
    ? `🚨 deploy-kit monitor: ${failing.length} issue(s) on ${host}`
    : (recovered.length ? `✅ deploy-kit monitor: recovered on ${host}` : `deploy-kit monitor: ${host}`);

  const lines = [];
  for (const a of failing) lines.push(`• [${String(a.status || '?').toUpperCase()}/${a.kind}] ${a.id}: ${a.message}`);
  for (const a of recovered) lines.push(`• [OK/recovery] ${a.id}: ${a.message}`);

  const body = lines.length ? lines.join('\n') : '(alert event carried no check details)';
  return `**${title}**\n${body}`;
}

// POST the message to the Discord webhook, bounded by a short timeout so a hung
// network call can never wedge a monitor cron run. `fetchImpl` is the injection
// seam — tests supply a fake so no real network call is ever made.
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

// Entry point shared by the CLI: read the alert JSON already collected from stdin,
// resolve the webhook URL, format + POST. Every failure mode is a loud, clear
// message on stderr and a non-zero return — never an uncaught stack trace.
async function alertDiscord({ stdin, webhookEnvName = DEFAULT_WEBHOOK_ENV, env = process.env, fetchImpl, log }) {
  const webhookUrl = env[webhookEnvName];
  if (!webhookUrl) {
    log.error(`alert-discord: alert webhook not configured (set ${webhookEnvName})`);
    return 1;
  }

  let event;
  try {
    event = JSON.parse(stdin);
  } catch (error) {
    log.error(`alert-discord: malformed alert JSON on stdin (${error.message})`);
    return 1;
  }

  const content = formatDiscordMessage(event);
  try {
    const result = await postToDiscord(webhookUrl, content, { fetchImpl });
    if (result.ok) {
      log.success(`alert-discord: posted to Discord (HTTP ${result.status})`);
      return 0;
    }
    log.error(`alert-discord: Discord POST failed (HTTP ${result.status})`);
    return 1;
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? 'timed out' : (error && error.message) || String(error);
    log.error(`alert-discord: Discord POST failed (${redact(reason, webhookUrl)})`);
    return 1;
  }
}

module.exports = { DEFAULT_WEBHOOK_ENV, formatDiscordMessage, postToDiscord, alertDiscord };

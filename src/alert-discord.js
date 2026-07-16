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
const DEFAULT_SERVICE = 'deploy-kit';
const POST_TIMEOUT_MS = 10000;
const DISCORD_CONTENT_LIMIT = 2000;
const MAX_LINE_CHARS = 300;
const MAX_STDIN_BYTES = 256 * 1024;

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
function lineEmoji(kind, status) {
  if (kind === 'recovery') return '✅';
  if (kind === 'reminder') return '🔁';
  if (status === 'crit') return '🔴';
  if (status === 'warn') return '🟡';
  if (status === 'ok') return '✅';
  return '❓';
}

function headerEmoji(alerts) {
  if (alerts.some((alert) => alert.status === 'crit')) return '🚨';
  if (alerts.some((alert) => alert.status === 'warn')) return '⚠️';
  return '✅';
}

function capLine(line) {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
}

function assembleMessage(header, bodyLines, footer, omitted) {
  const lines = [header, ...bodyLines];
  if (omitted > 0) lines.push(`…(+${omitted} more)`);
  lines.push(footer);
  return lines.join('\n');
}

function fitDiscordContent(header, bodyLines, footer) {
  let content = assembleMessage(header, bodyLines, footer, 0);
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;

  const kept = [...bodyLines];
  while (kept.length > 0) {
    kept.pop();
    content = assembleMessage(header, kept, footer, bodyLines.length - kept.length);
    if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  }
  return `${content.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`;
}

function formatDiscordMessage(event, { service = DEFAULT_SERVICE } = {}) {
  const host = (event && event.host) || 'unknown-host';
  const alerts = Array.isArray(event && event.alerts)
    ? event.alerts.filter((alert) => alert && typeof alert === 'object')
    : [];
  const header = `${headerEmoji(alerts)} ${service} monitor — ${host}`;
  const bodyLines = alerts.map((alert) => {
    const id = alert.id || 'unknown-check';
    return capLine(`${lineEmoji(alert.kind, alert.status)} \`${id}\` ${alert.message || id}`);
  });
  const footer = `— event \`${(event && event.eventId) || 'unknown'}\``;
  return fitDiscordContent(header, bodyLines, footer);
}

// POST the message to the Discord webhook, bounded by a short timeout so a hung
// network call can never wedge a monitor cron run. `fetchImpl` is the injection
// seam — tests supply a fake so no real network call is ever made.
async function postToDiscord(webhookUrl, content, { fetchImpl, timeoutMs = POST_TIMEOUT_MS, username } = {}) {
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(username ? { content, username } : { content }),
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
async function alertDiscord({
  stdin, webhookEnvName = DEFAULT_WEBHOOK_ENV, service, env = process.env, fetchImpl, log,
}) {
  if (typeof stdin !== 'string' || Buffer.byteLength(stdin, 'utf8') > MAX_STDIN_BYTES) {
    log.warning('alert-discord: stdin exceeded the size cap — dropping non-retryable alert batch');
    return 0;
  }

  let event;
  try {
    event = JSON.parse(stdin);
  } catch (error) {
    log.warning(`alert-discord: malformed alert JSON on stdin (${error.message}) — dropping non-retryable alert batch`);
    return 0;
  }

  if (!event || typeof event !== 'object' || Array.isArray(event) || !Array.isArray(event.alerts)) {
    log.warning('alert-discord: alert batch is not a { alerts: [...] } object — dropping non-retryable alert batch');
    return 0;
  }
  const alerts = event.alerts.filter((alert) => alert && typeof alert === 'object');
  if (alerts.length === 0) {
    log.warning('alert-discord: alert batch has no usable alerts — dropping non-retryable alert batch');
    return 0;
  }

  const webhookUrl = env[webhookEnvName];
  if (!webhookUrl) {
    log.error(`alert-discord: alert webhook not configured (set ${webhookEnvName})`);
    return 1;
  }

  const resolvedService = service || env.DISCORD_ALERT_SERVICE || DEFAULT_SERVICE;
  const content = formatDiscordMessage({ ...event, alerts }, { service: resolvedService });
  try {
    const result = await postToDiscord(webhookUrl, content, { fetchImpl, username: `${resolvedService} monitor` });
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

module.exports = {
  DEFAULT_WEBHOOK_ENV,
  DEFAULT_SERVICE,
  DISCORD_CONTENT_LIMIT,
  MAX_STDIN_BYTES,
  formatDiscordMessage,
  postToDiscord,
  alertDiscord,
};

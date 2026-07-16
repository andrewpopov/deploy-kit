import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'stream';

const require = createRequire(__filename);
const alertDiscordMod = require('../alert-discord.js') as typeof import('../alert-discord');
const { formatDiscordMessage, alertDiscord, DEFAULT_WEBHOOK_ENV, DISCORD_CONTENT_LIMIT } = alertDiscordMod;
const { run } = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

// Capture everything the CLI writes (same pattern as port-guard.test.ts) so we can
// assert which message a failure mode produced, and that the webhook URL never
// appears in any logged line.
function captureLog(): { out: () => string; restore: () => void } {
  let out = '';
  const sink = (m: string): void => { out += String(m) + '\n'; };
  const spies = ['error', 'success', 'info', 'step', 'header', 'warning'].map((m) =>
    log[m] ? vi.spyOn(log, m).mockImplementation(sink) : null,
  );
  return { out: () => out, restore: () => { for (const s of spies) s?.mockRestore(); } };
}

const SAMPLE_EVENT = {
  eventId: '123-abc',
  createdAtMs: 1_800_000_000_000,
  host: 'app@pi',
  alerts: [
    { id: 'pm2:app', kind: 'alert', status: 'crit', message: 'app not online (stopped)' },
    { id: 'disk:/srv/app', kind: 'recovery', status: 'ok', message: 'disk ok (900000 KiB free)' },
  ],
};

describe('formatDiscordMessage', () => {
  it('renders a title and one line per failing/recovered check', () => {
    const msg = formatDiscordMessage(SAMPLE_EVENT);
    expect(msg).toMatch(/🚨 deploy-kit monitor — app@pi/);
    expect(msg).toMatch(/🔴 `pm2:app` app not online \(stopped\)/);
    expect(msg).toMatch(/✅ `disk:\/srv\/app` disk ok \(900000 KiB free\)/);
    expect(msg).toMatch(/— event `123-abc`/);
  });

  it('supports service branding and bounds the message to Discord limits', () => {
    const event = {
      ...SAMPLE_EVENT,
      alerts: Array.from({ length: 20 }, (_, index) => ({
        id: `check-${index}`,
        kind: index === 0 ? 'reminder' : 'alert',
        status: 'warn',
        message: 'x'.repeat(500),
      })),
    };
    const msg = formatDiscordMessage(event, { service: 'smarthome' });
    expect(msg).toMatch(/smarthome monitor/);
    expect(msg).toMatch(/🔁 `check-0`/);
    expect(msg).toMatch(/…\(\+\d+ more\)/);
    expect(msg.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
  });
});

describe('alertDiscord (module)', () => {
  it('posts the formatted body to the env-resolved webhook URL on 2xx', async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 204 };
    };
    const cap = captureLog();
    const code = await alertDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: { DISCORD_ALERT_WEBHOOK: 'https://discord.example/webhooks/1/secret-token' },
      fetchImpl,
      log,
    });
    cap.restore();
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.example/webhooks/1/secret-token');
    expect(calls[0].body.content).toBe(formatDiscordMessage(SAMPLE_EVENT));
    expect(calls[0].body.username).toBe('deploy-kit monitor');
  });

  it('never logs the webhook URL, on success or failure', async () => {
    const webhook = 'https://discord.example/webhooks/1/super-secret-token';
    const cap = captureLog();
    await alertDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: { DISCORD_ALERT_WEBHOOK: webhook },
      fetchImpl: async () => { throw new Error(`request to ${webhook} failed`); },
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(out).not.toContain(webhook);
    expect(out).toContain('[redacted webhook URL]');
  });

  it('env var unset -> non-zero, clear stderr message, no crash', async () => {
    const cap = captureLog();
    const code = await alertDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: {},
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(1);
    expect(out).toMatch(/alert webhook not configured/);
    expect(out).toMatch(new RegExp(DEFAULT_WEBHOOK_ENV));
  });

  it('respects a custom webhook env var name', async () => {
    const calls: string[] = [];
    const code = await alertDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      webhookEnvName: 'MY_CUSTOM_HOOK',
      env: { MY_CUSTOM_HOOK: 'https://discord.example/custom' },
      fetchImpl: async (url: string) => { calls.push(url); return { ok: true, status: 204 }; },
      log,
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['https://discord.example/custom']);
  });

  it('malformed stdin JSON is dropped instead of poisoning the retry outbox', async () => {
    const cap = captureLog();
    const code = await alertDiscord({
      stdin: '{not valid json',
      env: { DISCORD_ALERT_WEBHOOK: 'https://discord.example/webhooks/1/x' },
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(0);
    expect(out).toMatch(/malformed alert JSON/);
    expect(out).toMatch(/non-retryable/);
  });

  it('invalid and empty alert batches are dropped without attempting delivery', async () => {
    const fetchImpl = vi.fn();
    const cap = captureLog();
    const invalid = await alertDiscord({ stdin: 'null', env: {}, fetchImpl, log });
    const empty = await alertDiscord({ stdin: JSON.stringify({ alerts: [null, 'bad'] }), env: {}, fetchImpl, log });
    cap.restore();

    expect(invalid).toBe(0);
    expect(empty).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a failed (non-2xx) POST is reported clearly and non-zero', async () => {
    const cap = captureLog();
    const code = await alertDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: { DISCORD_ALERT_WEBHOOK: 'https://discord.example/webhooks/1/x' },
      fetchImpl: async () => ({ ok: false, status: 500 }),
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(1);
    expect(out).toMatch(/Discord POST failed \(HTTP 500\)/);
  });
});

describe('CLI: alert-discord subcommand dispatch', () => {
  it('the subcommand is dispatched and --webhook-env parses (not rejected by parseOptions)', async () => {
    // Env deliberately unset for the custom var so this resolves deterministically
    // without a real network call — the point is proving DISPATCH + FLAG PARSING,
    // not the POST itself (covered above). Before a dispatch bug, an unrecognised
    // `--webhook-env` would hit parseOptions and print "Valid options: --lines, ...".
    const cap = captureLog();
    const stdin = Readable.from([JSON.stringify(SAMPLE_EVENT)]);
    const code = await run(['alert-discord', '--webhook-env', 'SOME_OTHER_VAR', '--service', 'smarthome'], {
      stdin, env: {},
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(1);
    expect(out).toMatch(/alert webhook not configured \(set SOME_OTHER_VAR\)/);
    expect(out).not.toMatch(/Valid options: --lines/); // parseOptions must not have rejected the flag
    expect(out).not.toMatch(/Unknown command/);
  });

  it('runs standalone without a .deploy-kit.config.json in cwd', async () => {
    const stdin = Readable.from([JSON.stringify(SAMPLE_EVENT)]);
    const calls: string[] = [];
    const code = await run(['alert-discord'], {
      cwd: '/nonexistent/no-config-here',
      stdin,
      env: { DISCORD_ALERT_WEBHOOK: 'https://discord.example/webhooks/1/x' },
      fetchImpl: async (url: string) => { calls.push(url); return { ok: true, status: 204 }; },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['https://discord.example/webhooks/1/x']);
  });

  it('bounds stdin and drops oversized batches without poisoning retries', async () => {
    const cap = captureLog();
    const code = await run(['alert-discord'], {
      stdin: Readable.from(['x'.repeat(256 * 1024 + 1)]),
      env: {},
    });
    const out = cap.out();
    cap.restore();

    expect(code).toBe(0);
    expect(out).toMatch(/stdin exceeded the size cap/);
    expect(out).not.toMatch(/webhook not configured/);
  });
});

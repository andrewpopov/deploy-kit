import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { Readable } from 'stream';

const require = createRequire(__filename);
const announceDiscordMod = require('../announce-discord.js') as typeof import('../announce-discord');
const { formatDiscordMessage, announceDiscord, DEFAULT_WEBHOOK_ENV } = announceDiscordMod;
const { run } = require('../cli.js') as { run: (argv: string[], opts?: any) => number | Promise<number> };
const { log } = require('../log.js') as { log: Record<string, (m: string) => void> };

// Capture everything the CLI writes (same pattern as alert-discord.test.ts) so we
// can assert which message a mode produced, and that the webhook URL never
// appears in any logged line.
function captureLog(): { out: () => string; restore: () => void } {
  let out = '';
  const sink = (m: string): void => { out += String(m) + '\n'; };
  const spies = ['error', 'success', 'info', 'step', 'header', 'warning'].map((m) =>
    log[m] ? vi.spyOn(log, m).mockImplementation(sink) : null,
  );
  return { out: () => out, restore: () => { for (const s of spies) s?.mockRestore(); } };
}

// The real deliveryEvent shape piped on stdin by deploy.js/release.js — see
// deploy.js ~line 279-287 and release.js ~line 576-587.
const SAMPLE_EVENT = {
  event: 'deployment',
  status: 'succeeded',
  branch: 'main',
  revision: 'abc1234def5678901234567890123456789abcd',
  deployedAt: '2026-07-11T18:30:00.000Z',
};

describe('formatDiscordMessage', () => {
  it('renders service, branch, short sha, and a readable timestamp', () => {
    const msg = formatDiscordMessage(SAMPLE_EVENT, { service: 'towerpower' });
    expect(msg).toBe('🚀 `towerpower` deployed `main@abc1234` at 2026-07-11 18:30:00 UTC');
  });

  it('falls back to the default service name when none is given', () => {
    const msg = formatDiscordMessage(SAMPLE_EVENT);
    expect(msg).toMatch(/^🚀 `app` deployed/);
  });
});

describe('announceDiscord (module)', () => {
  it('posts the formatted body to the env-resolved webhook URL on 2xx', async () => {
    const calls: { url: string; body: any }[] = [];
    const fetchImpl = async (url: string, opts: any) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 204 };
    };
    const cap = captureLog();
    const code = await announceDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: { DISCORD_RELEASE_WEBHOOK: 'https://discord.example/webhooks/1/secret-token' },
      fetchImpl,
      log,
    });
    cap.restore();
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.example/webhooks/1/secret-token');
    expect(calls[0].body.content).toBe(formatDiscordMessage(SAMPLE_EVENT, { service: 'app' }));
  });

  it('never logs the webhook URL, on success or failure', async () => {
    const webhook = 'https://discord.example/webhooks/1/super-secret-token';
    const cap = captureLog();
    await announceDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: { DISCORD_RELEASE_WEBHOOK: webhook },
      fetchImpl: async () => { throw new Error(`request to ${webhook} failed`); },
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(out).not.toContain(webhook);
    expect(out).toContain('[redacted webhook URL]');
  });

  // The key asymmetry vs alert-discord: a missing release webhook is a SKIP
  // (exit 0), not a failure — a healthy deploy must never go red because
  // nobody wired up a Discord channel for release announcements yet.
  it('env var unset -> exit 0, clear skip message on stderr, no crash', async () => {
    const cap = captureLog();
    const code = await announceDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: {},
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(0);
    expect(out).toMatch(/not set — skipping release announcement/);
    expect(out).toMatch(new RegExp(DEFAULT_WEBHOOK_ENV));
  });

  it('respects a custom webhook env var name and --service value', async () => {
    const calls: { url: string; body: any }[] = [];
    const code = await announceDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      webhookEnvName: 'MY_CUSTOM_HOOK',
      service: 'kira',
      env: { MY_CUSTOM_HOOK: 'https://discord.example/custom' },
      fetchImpl: async (url: string, opts: any) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; },
      log,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.example/custom');
    expect(calls[0].body.content).toMatch(/^🚀 `kira` deployed/);
  });

  // deliveryEvent is already a tolerated, best-effort step — a broken
  // announcement must never fail a deploy that already succeeded.
  it('malformed stdin JSON -> exit 0, clear warning, no crash', async () => {
    const cap = captureLog();
    const code = await announceDiscord({
      stdin: '{not valid json',
      env: { DISCORD_RELEASE_WEBHOOK: 'https://discord.example/webhooks/1/x' },
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(0);
    expect(out).toMatch(/malformed delivery-event JSON/);
  });

  it('a failed (non-2xx) POST is reported clearly but still exits 0', async () => {
    const cap = captureLog();
    const code = await announceDiscord({
      stdin: JSON.stringify(SAMPLE_EVENT),
      env: { DISCORD_RELEASE_WEBHOOK: 'https://discord.example/webhooks/1/x' },
      fetchImpl: async () => ({ ok: false, status: 500 }),
      log,
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(0);
    expect(out).toMatch(/Discord POST failed \(HTTP 500\)/);
  });
});

describe('CLI: announce-discord subcommand dispatch', () => {
  it('the subcommand is dispatched and --webhook-env/--service parse (not rejected by parseOptions)', async () => {
    const cap = captureLog();
    const stdin = Readable.from([JSON.stringify(SAMPLE_EVENT)]);
    const code = await run(['announce-discord', '--webhook-env', 'SOME_OTHER_VAR', '--service', 'kira'], {
      stdin, env: {},
    });
    const out = cap.out();
    cap.restore();
    expect(code).toBe(0);
    expect(out).toMatch(/SOME_OTHER_VAR not set — skipping release announcement/);
    expect(out).not.toMatch(/Valid options: --lines/); // parseOptions must not have rejected the flags
    expect(out).not.toMatch(/Unknown command/);
  });

  it('runs standalone without a .deploy-kit.config.json in cwd', async () => {
    const stdin = Readable.from([JSON.stringify(SAMPLE_EVENT)]);
    const calls: string[] = [];
    const code = await run(['announce-discord'], {
      cwd: '/nonexistent/no-config-here',
      stdin,
      env: { DISCORD_RELEASE_WEBHOOK: 'https://discord.example/webhooks/1/x' },
      fetchImpl: async (url: string) => { calls.push(url); return { ok: true, status: 204 }; },
    });
    expect(code).toBe(0);
    expect(calls).toEqual(['https://discord.example/webhooks/1/x']);
  });
});

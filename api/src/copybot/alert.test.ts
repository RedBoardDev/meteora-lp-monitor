/**
 * Copy-bot — external alert webhook sink. These tests encode the WHY:
 *  - no `ALERT_WEBHOOK` ⇒ NO sink and NO fetch (nothing happens without config, as before the P2 migration);
 *  - a configured URL ⇒ ONE POST carrying the operator-actionable event's identity (code/severity/reason/…);
 *  - a failing fetch (sync throw OR rejected promise) is swallowed — a dead webhook must NEVER break the bot.
 */
import type { Logger } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CopyEvent } from '@/domain/copybot/observability/event';
import { createAlertWebhookSink } from './alert';

function fakeLog(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as unknown as Logger & { warn: ReturnType<typeof vi.fn> };
}

const PINNED_EVENT = {
  code: 'failsafe.failed',
  severity: 'error',
  category: 'FAILSAFE',
  audience: 'feed',
  pinned: true,
  ts: 1234,
  eventTs: 1234,
  ctx: { userId: 'system', wallet: 'W', process: 'coffre' },
  stage: 'failsafe',
  outcome: 'failed',
  reason: 'close manually',
  adminDetail: { position: 'POS' },
} as unknown as CopyEvent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAlertWebhookSink', () => {
  it('returns undefined (no-op, no fetch) when ALERT_WEBHOOK is unset', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(createAlertWebhookSink(undefined, fakeLog())).toBeUndefined();
    expect(createAlertWebhookSink('', fakeLog())).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs the event identity (code/severity/reason/adminDetail/ts) as JSON to the configured URL', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const sink = createAlertWebhookSink('https://hook.example/alert', fakeLog());
    sink!(PINNED_EVENT);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://hook.example/alert');
    expect(init!.method).toBe('POST');
    expect((init!.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init!.body as string)).toEqual({
      code: 'failsafe.failed',
      severity: 'error',
      reason: 'close manually',
      adminDetail: { position: 'POS' },
      ts: 1234,
    });
    expect(init!.signal).toBeInstanceOf(AbortSignal); // timeout-bounded
  });

  it('swallows a REJECTED fetch and warn-logs (a dead webhook must never break the bot)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const log = fakeLog();
    const sink = createAlertWebhookSink('https://hook.example/alert', log);
    expect(() => sink!(PINNED_EVENT)).not.toThrow();
    await Promise.resolve(); // let the .catch microtask run
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('swallows a SYNCHRONOUS fetch throw and warn-logs (never propagates into emit)', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('boom sync');
    });
    const log = fakeLog();
    const sink = createAlertWebhookSink('https://hook.example/alert', log);
    expect(() => sink!(PINNED_EVENT)).not.toThrow();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

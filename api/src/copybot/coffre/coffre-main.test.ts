import { describe, expect, it } from 'vitest';
import { CODE_REGISTRY } from '@/domain/copybot/observability/codes';
import { deadLetterCode, routeVerdict } from './coffre-main';

// FIX A — DLQ routing for rejected/poison cmd:sign verdicts. These pure helpers decide what the vault loop does with
// a processed message; the loop performs the I/O (ack / dead-letter / leave pending). Encodes the WHY: a poison/forged
// message must be quarantined with a durable trace (never a silent ack), and only a forged/malformed command pages the
// operator out-of-band — an expected duplicate/stale under retries must NOT.

describe('coffre routeVerdict — what the loop does with a verdict', () => {
  it('retryLater (#7 recovery in-flight) → RETAIN: leave UNACKED, NEVER dead-lettered (a prior broadcast may still land)', () => {
    expect(routeVerdict({ ok: false, reason: 'recover_in_flight', retryLater: true })).toEqual({ action: 'retain' });
    // retryLater wins even over an ok flag — it must stay in the PEL for a later chain re-check.
    expect(routeVerdict({ ok: true, retryLater: true })).toEqual({ action: 'retain' });
  });

  it('terminal-OK (landed / skipped / dry-run) → ACK, as before', () => {
    expect(routeVerdict({ ok: true, reason: 'dry-run' })).toEqual({ action: 'ack' });
    expect(routeVerdict({ ok: true })).toEqual({ action: 'ack' });
  });

  it('rejected (!ok) → DEAD-LETTER: durable quarantine + trace, never a silent ack', () => {
    const route = routeVerdict({ ok: false, reason: 'bad_hmac_or_hop' });
    expect(route.action).toBe('deadLetter');
  });
});

describe('coffre deadLetterCode — pinned differentiation of the dead-letter trace', () => {
  const POISON = ['bad_hmac_or_hop', 'bad_schema', 'commandId_mismatch', 'owner_mismatch', 'undecodable_tx'];
  const BENIGN = ['duplicate', 'stale'];

  it('forged / tampered / malformed → the dedicated pinned `system.command_quarantined` (NOT system.fatal — the process is alive)', () => {
    for (const reason of POISON) {
      const code = deadLetterCode(reason);
      // The truthful code: pinned (operator paged out-of-band) but NOT the "Bot Stopped" fatal — a single message
      // was quarantined while the vault keeps running. Fail-against-old: the prior `system.fatal` mapping is wrong.
      expect(code, reason).toBe('system.command_quarantined');
      expect(code, reason).not.toBe('system.fatal');
      expect(CODE_REGISTRY[code].pinned).toBe(true);
    }
  });

  it('benign / expected (duplicate, stale) → a NON-pinned internal trace (no false operator page under retries)', () => {
    for (const reason of BENIGN) {
      const code = deadLetterCode(reason);
      expect(code, reason).toBe('system.loop_errored');
      expect(CODE_REGISTRY[code].pinned ?? false).toBe(false);
      expect(CODE_REGISTRY[code].audience).toBe('internal');
    }
  });

  it('an unknown / undefined reason → non-pinned trace (fail-safe: never a spurious operator page)', () => {
    expect(CODE_REGISTRY[deadLetterCode(undefined)].pinned ?? false).toBe(false);
    expect(CODE_REGISTRY[deadLetterCode('some_future_reason')].pinned ?? false).toBe(false);
  });
});

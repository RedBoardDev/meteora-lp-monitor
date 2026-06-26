import { describe, expect, it } from 'vitest';
import { CreditMeter, CREDIT_COST, wsCredits } from './credit-meter';

/** A meter on a mutable clock so every time-based rule (rolling window, UTC-day) is deterministic. */
function meterAt(start: number, thresholds?: ConstructorParameters<typeof CreditMeter>[1]) {
  const clock = { now: start };
  const meter = new CreditMeter(() => clock.now, thresholds);
  return { meter, clock };
}

describe('wsCredits', () => {
  // WHY: Helius bills a WebSocket 1 credit to open + 20 per STARTED MB — an idle (0-byte) socket is the
  // 1-credit floor, and any partial MB rounds UP a full 20-credit block (so a noisy leader is costed).
  it('is 1 to open, +20 per started MB (idle = 1, sub-MB rounds up)', () => {
    expect(wsCredits(0)).toBe(1); // open only — idle stream
    expect(wsCredits(1)).toBe(21); // 1 byte starts the first MB → 1 + 20
    expect(wsCredits(1_000_000)).toBe(21); // exactly 1 MB → 1 + 20
    expect(wsCredits(1_000_001)).toBe(41); // just over 1 MB → 1 + 2*20
    expect(wsCredits(2_000_000)).toBe(41); // exactly 2 MB → 1 + 2*20
  });
});

describe('CreditMeter — credit accounting', () => {
  // WHY: the meter exists to attribute COST, not call counts — each method must add its exact Helius
  // credit cost (gPA=10, Enhanced=100, std=1) so /debug/rpc shows real spend, not request volume.
  it('sums credits per method (cost-weighted, not 1-per-call)', () => {
    const { meter } = meterAt(0);
    meter.record('getMultipleAccounts'); // 1
    meter.record('getProgramAccounts'); // 10
    meter.record('enhancedTx'); // 100
    const s = meter.stats();
    expect(s.totalCredits).toBe(
      CREDIT_COST.getMultipleAccounts! + CREDIT_COST.getProgramAccounts! + CREDIT_COST.enhancedTx!,
    );
    expect(s.totalCredits).toBe(111);
    expect(s.totalCalls).toBe(3);
    expect(s.byMethod).toEqual({ getMultipleAccounts: 1, getProgramAccounts: 10, enhancedTx: 100 });
  });

  // WHY: an unlisted std JSON-RPC method must still be costed (the Helius default = 1 credit), never 0,
  // or a new call site would silently spend untracked credits.
  it('costs an unknown method at the default (1 credit)', () => {
    const { meter } = meterAt(0);
    meter.record('getFoo');
    expect(meter.stats().totalCredits).toBe(CREDIT_COST.default!);
  });

  // WHY: attribution by code path is what lets us answer "which subsystem burned the credits" — the
  // whole point of tagging snapshot/ingest/realized.
  it('sums credits per code path and defaults to "unknown" when untagged', () => {
    const { meter } = meterAt(0);
    meter.record('getProgramAccounts', { codePath: 'snapshot' }); // 10
    meter.record('getSignaturesForAddress', { codePath: 'ingest' }); // 1
    meter.record('getAccountInfo'); // untagged → unknown, 1
    expect(meter.stats().byCodePath).toEqual({ snapshot: 10, ingest: 1, unknown: 1 });
  });

  // WHY: per-wallet credit sums power both the daily-budget anomaly and the kill-switch; a record with
  // no wallet must NOT pollute byWallet (it's not attributable to any tenant).
  it('sums credits per wallet only when a wallet is given', () => {
    const { meter } = meterAt(0);
    meter.record('enhancedTx', { wallet: 'A' }); // 100
    meter.record('enhancedTx', { wallet: 'B' }); // 100
    meter.record('getBalance'); // no wallet
    expect(meter.stats().byWallet).toEqual({ A: 100, B: 100 });
  });

  // WHY: bytes-mode routes the cost through wsCredits instead of the method map — a metered WebSocket
  // frame must be billed by volume, not as a flat 1-credit call.
  it('uses wsCredits when bytes are given', () => {
    const { meter } = meterAt(0);
    meter.record('ws', { bytes: 1_000_001 }); // 41
    expect(meter.stats().totalCredits).toBe(41);
  });
});

describe('CreditMeter — bounded ring', () => {
  // WHY: under sustained load an unbounded live-feed ring would grow until OOM; it MUST cap (2000) while
  // cumulative counters keep counting. White-box: assert the internal ring never exceeds the cap.
  it('caps the ring at 2000 entries while totals keep accumulating', () => {
    const { meter } = meterAt(0);
    for (let i = 0; i < 2100; i++) meter.record('getAccountInfo');
    const ringLen = (meter as unknown as { ring: unknown[] }).ring.length;
    expect(ringLen).toBe(2000); // oldest evicted
    expect(meter.stats().totalCalls).toBe(2100); // cumulative, not bounded
    expect(meter.stats().ringTail.length).toBe(50); // tail is the last ~50
  });
});

describe('CreditMeter — anomalies', () => {
  // WHY: the Enhanced API (100 cr/call) is BANNED from steady-state — it drained the key — so ANY use
  // is flagged, and nothing flags it before it's actually recorded.
  it('flags enhanced-used the moment an Enhanced call is recorded, not before', () => {
    const { meter } = meterAt(0);
    expect(meter.anomalies().some((a) => a.kind === 'enhanced-used')).toBe(false);
    meter.record('enhancedTx', { wallet: 'A' });
    expect(meter.anomalies().some((a) => a.kind === 'enhanced-used')).toBe(true);
  });

  // WHY: legacy getProgramAccounts is 10× the V2 cost; its presence on a recurring path is waste worth
  // surfacing — but getProgramAccountsV2 must NOT trip it.
  it('flags legacy-gpa only for getProgramAccounts, not the V2 variant', () => {
    const { meter } = meterAt(0);
    meter.record('getProgramAccountsV2');
    expect(meter.anomalies().some((a) => a.kind === 'legacy-gpa')).toBe(false);
    meter.record('getProgramAccounts');
    expect(meter.anomalies().some((a) => a.kind === 'legacy-gpa')).toBe(true);
  });

  // WHY: the per-minute alarm must fire strictly ABOVE the threshold (not at it), and must clear as the
  // 60s window rolls — it's a rate signal, not a cumulative one.
  it('credits-per-min-over fires above the threshold and clears as the window rolls', () => {
    const { meter, clock } = meterAt(1_000, { alarmCreditsPerMin: 50 });
    meter.record('das'); // +10 → 10
    meter.record('das'); // 20
    meter.record('das'); // 30
    meter.record('das'); // 40
    meter.record('das'); // 50 — AT threshold, not over
    expect(meter.anomalies().some((a) => a.kind === 'credits-per-min-over')).toBe(false);
    meter.record('getAccountInfo'); // 51 — now over
    expect(meter.anomalies().some((a) => a.kind === 'credits-per-min-over')).toBe(true);
    clock.now += 60_001; // roll the 60s window past every recorded credit
    expect(meter.anomalies().some((a) => a.kind === 'credits-per-min-over')).toBe(false);
  });

  // WHY: a single runaway wallet is the failure mode from the incident; its day-sum crossing budget must
  // flag THAT wallet (and only over-budget wallets).
  it('wallet-daily-budget flags the over-budget wallet only', () => {
    const { meter } = meterAt(0, { walletDailyBudget: 150 });
    meter.record('enhancedTx', { wallet: 'A' }); // 100
    meter.record('enhancedTx', { wallet: 'A' }); // 200 — over 150
    meter.record('enhancedTx', { wallet: 'B' }); // 100 — under
    const flagged = meter.anomalies().filter((a) => a.kind === 'wallet-daily-budget');
    expect(flagged.length).toBe(1);
    expect(flagged[0]!.detail).toContain('A');
  });
});

describe('CreditMeter — kill-switch', () => {
  // WHY: the global breaker halts ALL recurring RPC when a credit burst breaches the hard ceiling, then
  // releases once the rolling window drains — otherwise a runaway never recovers without a restart.
  it('blocks globally above the ceiling and releases as the window rolls', () => {
    const { meter, clock } = meterAt(1_000, { globalKillCreditsPerMin: 50 });
    expect(meter.shouldBlock()).toBe(false);
    meter.record('enhancedTx'); // 100 > 50
    expect(meter.shouldBlock()).toBe(true);
    clock.now += 60_001; // window rolls → credits age out
    expect(meter.shouldBlock()).toBe(false);
  });

  // WHY: a per-wallet budget breach must block only that wallet's calls; an under-budget wallet and the
  // global (no-wallet) check stay open, so one noisy tenant can't halt everyone.
  it('blocks the over-budget wallet without blocking others or the global check', () => {
    const { meter } = meterAt(0, { walletDailyBudget: 150, globalKillCreditsPerMin: 1_000_000 });
    meter.record('enhancedTx', { wallet: 'A' }); // 100
    meter.record('enhancedTx', { wallet: 'A' }); // 200 — over 150
    meter.record('enhancedTx', { wallet: 'B' }); // 100 — under
    expect(meter.shouldBlock('A')).toBe(true);
    expect(meter.shouldBlock('B')).toBe(false);
    expect(meter.shouldBlock()).toBe(false); // global budget not breached
  });
});

describe('CreditMeter — blocked marker', () => {
  // WHY: a kill-switch-blocked call was NEVER issued, so it must add 0 credits (not pollute the budget)
  // yet still appear in the live feed as a counted, failed, blocked entry.
  it('records a blocked call as 0 credits but a counted, flagged ring entry', () => {
    const { meter } = meterAt(0);
    meter.record('getAccountInfo'); // 1 real credit
    meter.recordBlocked('getProgramAccounts', { codePath: 'snapshot', wallet: 'A' });
    const s = meter.stats();
    expect(s.totalCredits).toBe(1); // blocked call added nothing
    expect(s.totalCalls).toBe(2); // but it was counted
    const last = s.ringTail.at(-1)!;
    expect(last.blocked).toBe(true);
    expect(last.credits).toBe(0);
    expect(last.ok).toBe(false);
  });
});

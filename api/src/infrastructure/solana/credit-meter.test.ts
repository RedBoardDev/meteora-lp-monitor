import { describe, expect, it } from 'vitest';
import { CREDIT_COST, type CreditFlushRow, CreditMeter, wsCredits } from './credit-meter';

/** A meter on a mutable clock so the time-based flush day-bucket is deterministic. */
function meterAt(start: number) {
  const clock = { now: start };
  const meter = new CreditMeter(() => clock.now);
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

  // WHY: per-wallet credit sums power the by-wallet breakdown on /debug/rpc; a record with no wallet
  // must NOT pollute byWallet (it's not attributable to any tenant).
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
});

describe('CreditMeter — drainForFlush (DB rollup buffer)', () => {
  const byKey = (r: CreditFlushRow) => `${r.day}|${r.method}|${r.wallet}|${r.codePath}`;

  // WHY: the 60s flush persists only the deltas SINCE the last drain, accumulated per
  // (day,method,wallet,codePath), while the cumulative stats() ledger must stay whole. Draining resets
  // ONLY the buffer, so a second drain with no new calls is empty — the timer never double-writes a
  // window into rpc_credit_daily, and a wallet-less call maps onto the '' bucket.
  it('returns per-key deltas, resets the buffer, and never disturbs the cumulative stats()', () => {
    const { meter } = meterAt(0);
    meter.record('getAccountInfo', { wallet: 'A', codePath: 'ingest' }); // 1
    meter.record('getAccountInfo', { wallet: 'A', codePath: 'ingest' }); // same key → 2 calls / 2 credits
    meter.record('enhancedTx', { wallet: 'B', codePath: 'realized' }); // 100, distinct key
    meter.record('getBalance'); // no wallet, untagged path → ('', 'unknown')

    const first = new Map(meter.drainForFlush().map((r) => [byKey(r), r]));
    expect(first.size).toBe(3);
    expect(first.get('0|getAccountInfo|A|ingest')).toMatchObject({ calls: 2, credits: 2 });
    expect(first.get('0|enhancedTx|B|realized')).toMatchObject({ calls: 1, credits: 100 });
    expect(first.get('0|getBalance||unknown')).toMatchObject({ calls: 1, credits: 1 });

    // Buffer reset: a second drain with no new records is empty…
    expect(meter.drainForFlush()).toEqual([]);
    // …yet the cumulative ledger is untouched (drain touches only the flush buffer).
    const s = meter.stats();
    expect(s.totalCredits).toBe(103);
    expect(s.totalCalls).toBe(4);

    // A NEW record after the reset accumulates fresh (from the emptied buffer, not the cumulative sum).
    meter.record('getAccountInfo', { wallet: 'A', codePath: 'ingest' });
    expect(meter.drainForFlush()).toEqual([
      { day: 0, method: 'getAccountInfo', wallet: 'A', codePath: 'ingest', calls: 1, credits: 1 },
    ]);
  });

  // WHY: the day bucket comes from the injected clock, so calls on different UTC days flush to DISTINCT
  // rows — the rollup is day-partitioned exactly like rpc_credit_daily's PK.
  it('partitions deltas by UTC day from the clock', () => {
    const { meter, clock } = meterAt(0);
    meter.record('getAccountInfo', { wallet: 'A', codePath: 'ingest' }); // day 0
    clock.now = 86_400_000; // next UTC day
    meter.record('getAccountInfo', { wallet: 'A', codePath: 'ingest' }); // day 1
    expect(
      meter
        .drainForFlush()
        .map((r) => r.day)
        .sort(),
    ).toEqual([0, 1]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type DetectedEvent,
  type DetectorDeps,
  LeaderDetector,
  type SigInfo,
} from './leader-detector';

function fakeEvent(signature: string, blockTime: number | null = null): DetectedEvent {
  return {
    signature,
    blockTime,
    instruction: 'AddLiquidityByStrategy2',
    depositSol: 1,
    withdrawSol: 0,
    claimSol: 0,
    closed: false,
    pool: 'pool1',
    position: 'pos1',
    nonSolMint: 'mintNonSol',
    nonSolSymbol: null,
  };
}

/**
 * Fake deps over a fixed CHRONOLOGICAL signature stream (oldest→newest). `listSignaturesSince` mimics
 * Solana's `getSignaturesForAddress({ until })`: a CONTIGUOUS, newest-first slice of everything newer than
 * the cursor. `dlmm` is the subset that are real DLMM events.
 */
function makeDeps(chronological: string[], dlmm: Set<string>, blockTimes: Record<string, number> = {}) {
  const emitted: Array<{ signature: string; source: string }> = [];
  const deps: DetectorDeps = {
    async listSignaturesSince(until: string | undefined): Promise<SigInfo[]> {
      const start = until === undefined ? 0 : chronological.indexOf(until) + 1;
      return chronological
        .slice(start)
        .reverse() // newest-first, like the RPC
        .map((signature) => ({ signature }));
    },
    async classify(signatures: string[]): Promise<Map<string, DetectedEvent>> {
      const m = new Map<string, DetectedEvent>();
      for (const s of signatures) if (dlmm.has(s)) m.set(s, fakeEvent(s, blockTimes[s] ?? null));
      return m;
    },
    onEvent(event, source) {
      emitted.push({ signature: event.signature, source });
    },
  };
  return { deps, emitted };
}

describe('LeaderDetector — "we never miss an event" robustness', () => {
  it('the poll emits all fresh DLMM events, in chrono order, and ignores non-DLMM tx', async () => {
    const { deps, emitted } = makeDeps(['a', 'b', 'c', 'd'], new Set(['a', 'c', 'd'])); // b = non-DLMM
    const det = new LeaderDetector(deps);

    await det.poll();

    expect(emitted.map((e) => e.signature)).toEqual(['a', 'c', 'd']); // chrono, b filtered out
    expect(det.cursorSignature).toBe('d'); // cursor advanced to the newest
  });

  it('emits by blockTime (the RPC signature order is not strictly chronological)', async () => {
    // RPC order = a,b,c; but out-of-order timestamps b=10, a=20, c=30 → expected b, a, c
    const { deps, emitted } = makeDeps(['a', 'b', 'c'], new Set(['a', 'b', 'c']), { a: 20, b: 10, c: 30 });
    const det = new LeaderDetector(deps);

    await det.poll();

    expect(emitted.map((e) => e.signature)).toEqual(['b', 'a', 'c']);
  });

  it('dedup: an event seen by the WS is NOT re-emitted by the poll that overlaps it', async () => {
    const { deps, emitted } = makeDeps(['a', 'b', 'c'], new Set(['a', 'b', 'c']));
    const det = new LeaderDetector(deps);

    await det.onWsSignature('b'); // the WS delivers b early
    await det.poll(); // the poll re-lists a,b,c

    const sigs = emitted.map((e) => e.signature);
    expect(sigs).toEqual(['b', 'a', 'c']); // b (ws) then a,c (poll) — b only once
    expect(sigs.filter((s) => s === 'b')).toHaveLength(1);
  });

  it('NEVER-MISS: an event the WS missed is recovered by the poll (each event exactly once)', async () => {
    const chrono = ['a', 'b', 'c', 'd', 'e'];
    const { deps, emitted } = makeDeps(chrono, new Set(chrono)); // all DLMM
    const det = new LeaderDetector(deps);

    // The WS only delivers b and d; a, c and e are "missed" by the WS (drop / disconnect).
    await det.onWsSignature('b');
    await det.onWsSignature('d');
    // The backstop: the poll re-sweeps everything and recovers the missing ones.
    await det.poll();

    const sigs = emitted.map((e) => e.signature).sort();
    expect(sigs).toEqual(['a', 'b', 'c', 'd', 'e']); // NONE missed
    expect(new Set(sigs).size).toBe(5); // NO duplicate
    // The events missed by the WS were indeed emitted by the poll.
    expect(emitted.find((e) => e.signature === 'c')?.source).toBe('poll');
    expect(emitted.find((e) => e.signature === 'e')?.source).toBe('poll');
  });

  it('NO-MISS: a WS sig whose tx is not yet queryable (classify yields NOTHING, no throw) is re-covered by the poll', async () => {
    // WHY: the WS can outrun tx availability at the RPC — classify returns an empty map WITHOUT throwing. The
    // reserved sig must NOT stay in `seen`, or the contiguous poll would skip it FOREVER. This was a real bug:
    // a live close (and the very first open) got burned in `seen` by the WS and only the 30s reconcile saved it.
    const emitted: string[] = [];
    let txReady = false; // the tx becomes queryable only AFTER the WS notification (the race)
    const deps: DetectorDeps = {
      async listSignaturesSince(): Promise<SigInfo[]> {
        return [{ signature: 'x' }];
      },
      async classify(sigs: string[]): Promise<Map<string, DetectedEvent>> {
        const m = new Map<string, DetectedEvent>();
        if (txReady) for (const s of sigs) m.set(s, fakeEvent(s, 1));
        return m; // before txReady: empty (the WS-raced-RPC case), NOT a throw
      },
      onEvent(e) {
        emitted.push(e.signature);
      },
    };
    const det = new LeaderDetector(deps);

    await det.onWsSignature('x'); // WS fires, tx not queryable yet → no event emitted
    expect(emitted).toEqual([]);
    txReady = true;
    await det.poll(); // backstop: 'x' was un-reserved, so the poll re-covers it
    expect(emitted).toEqual(['x']); // recovered, exactly once
  });

  it('NO-MISS multi-cycle: intermittent WS (drops/reconnects) + poll = total coverage, exactly once', async () => {
    // On-chain stream that grows in rounds. On each round the WS delivers a subset (simulates
    // drops/reconnects), then the poll sweeps. At the end: EVERY event emitted exactly once.
    const rounds = [
      { sigs: ['a0', 'a1', 'a2'], wsDeliver: [] as number[] }, // WS down → the poll catches up on everything
      { sigs: ['b0', 'b1', 'b2'], wsDeliver: [0, 1, 2] }, // WS delivers all → the poll re-emits nothing
      { sigs: ['c0', 'c1', 'c2'], wsDeliver: [0] }, // partial WS → the poll catches up on c1, c2
      { sigs: ['d0', 'd1', 'd2'], wsDeliver: [] }, // WS down again
    ];
    const available: string[] = [];
    const emitted: string[] = [];
    const deps: DetectorDeps = {
      async listSignaturesSince(until) {
        const start = until === undefined ? 0 : available.indexOf(until) + 1;
        return available
          .slice(start)
          .reverse()
          .map((signature) => ({ signature }));
      },
      async classify(sigs) {
        return new Map(sigs.map((s) => [s, fakeEvent(s)]));
      },
      onEvent(e) {
        emitted.push(e.signature);
      },
    };
    const det = new LeaderDetector(deps);

    for (const r of rounds) {
      available.push(...r.sigs); // the chain advances on-chain
      for (const i of r.wsDeliver) {
        const sig = r.sigs[i];
        if (sig) await det.onWsSignature(sig); // the WS (lossy) fires early
      }
      await det.poll(); // the backstop sweeps
    }

    const allSigs = rounds.flatMap((r) => r.sigs);
    expect([...emitted].sort()).toEqual([...allSigs].sort()); // none missed
    expect(emitted.length).toBe(allSigs.length); // no duplicate
  });

  it('NEVER-MISS on write: a persist that fails → rollback, the event is rewritten on the next poll', async () => {
    const persisted: string[] = [];
    let failOnce = true;
    const deps: DetectorDeps = {
      // as long as the cursor isn't advanced, the poll re-lists 'a'
      async listSignaturesSince(until) {
        return until === undefined ? [{ signature: 'a' }] : [];
      },
      async classify(sigs) {
        return new Map(sigs.map((s) => [s, fakeEvent(s)]));
      },
      onEvent() {},
      async persist(events) {
        if (failOnce) {
          failOnce = false;
          throw new Error('db down');
        }
        for (const e of events) persisted.push(e.signature);
      },
    };
    const det = new LeaderDetector(deps);

    await expect(det.poll()).rejects.toThrow('db down'); // the write fails
    expect(det.cursorSignature).toBeUndefined(); // cursor NOT advanced
    expect(persisted).toEqual([]); // nothing written

    await det.poll(); // automatic retry
    expect(persisted).toEqual(['a']); // the event (a potential close!) is recovered
    expect(det.cursorSignature).toBe('a');
  });

  it('NEVER-MISS on read: a signature listing that fails (RPC down / poll cap) → cursor not advanced', async () => {
    // Covers a `listSignaturesSince` failure (RPC that throws, or watch-leader's MAX_POLL_PAGES guard).
    // The window must NEVER be considered covered: the cursor stays behind → re-swept.
    let fail = true;
    const deps: DetectorDeps = {
      async listSignaturesSince() {
        if (fail) {
          fail = false;
          throw new Error('rpc down');
        }
        return [{ signature: 'a' }];
      },
      async classify(sigs) {
        return new Map(sigs.map((s) => [s, fakeEvent(s)]));
      },
      onEvent() {},
    };
    const det = new LeaderDetector(deps);

    await expect(det.poll()).rejects.toThrow('rpc down');
    expect(det.cursorSignature).toBeUndefined(); // nothing captured → the window will be re-swept

    await det.poll(); // retry
    expect(det.cursorSignature).toBe('a'); // recovered, no hole
  });

  it('the bounded `seen` set evicts oldest-first and biases to a re-emit, NEVER a miss', async () => {
    // WHY: `seen` is capped (memory bound) — when it overflows it drops the OLDEST signature. The dropped sig is
    // always behind the cursor, so the worst case is the poll re-emitting it (a duplicate, deduped downstream),
    // never a miss. A regression that evicted a still-in-window sig the poll couldn't recover would break no-miss.
    const { deps, emitted } = makeDeps(['a', 'b', 'c'], new Set(['a', 'b', 'c']));
    const det = new LeaderDetector(deps, 2); // seenMax = 2 → the 3rd WS sig evicts 'a'

    await det.onWsSignature('a'); // seen = {a}
    await det.onWsSignature('b'); // seen = {a, b}
    await det.onWsSignature('c'); // seen = {b, c} — 'a' evicted (but it WAS already emitted)
    await det.poll(); // re-lists a,b,c → only 'a' is fresh again (b,c still seen) → re-emitted (duplicate, OK)

    const sigs = emitted.map((e) => e.signature);
    expect(sigs).toEqual(['a', 'b', 'c', 'a']); // 3 via WS, then 'a' once more via the poll (evicted → re-fresh)
    expect(sigs.filter((s) => s === 'b')).toHaveLength(1); // still-seen sigs are NOT re-emitted
    expect(sigs.filter((s) => s === 'c')).toHaveLength(1);
  });

  it('NO-MISS under eviction pressure: a `seen` smaller than the live window still loses NOTHING', async () => {
    // The dedup window is intentionally smaller than the burst → forces evictions every round. Invariant: every
    // event is still emitted at least once (no-miss); duplicates from eviction are acceptable (deduped downstream).
    const available: string[] = [];
    const emitted: string[] = [];
    const deps: DetectorDeps = {
      async listSignaturesSince(until) {
        const start = until === undefined ? 0 : available.indexOf(until) + 1;
        return available.slice(start).reverse().map((signature) => ({ signature }));
      },
      async classify(sigs) {
        return new Map(sigs.map((s) => [s, fakeEvent(s)]));
      },
      onEvent(e) {
        emitted.push(e.signature);
      },
    };
    const det = new LeaderDetector(deps, 3); // tiny dedup window vs 3-per-round bursts

    const allSigs: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const sigs = [`r${round}s0`, `r${round}s1`, `r${round}s2`];
      allSigs.push(...sigs);
      available.push(...sigs);
      await det.onWsSignature(sigs[0] as string); // partial WS each round
      await det.poll(); // backstop sweep advances the cursor
    }

    for (const s of allSigs) expect(emitted).toContain(s); // NONE missed, even with constant eviction
    expect(det.cursorSignature).toBe(allSigs[allSigs.length - 1]); // cursor reached the newest
  });

  it('the WS never advances the cursor (only the poll does) — guarantees the contiguous sweep', async () => {
    const { deps } = makeDeps(['a', 'b', 'c'], new Set(['a', 'b', 'c']));
    const det = new LeaderDetector(deps);

    await det.onWsSignature('c'); // even the newest via WS
    expect(det.cursorSignature).toBeUndefined(); // cursor intact → the poll will re-cover a,b,c

    await det.poll();
    expect(det.cursorSignature).toBe('c');
  });
});

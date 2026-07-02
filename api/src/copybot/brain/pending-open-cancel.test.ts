/**
 * Copy-bot · BRAIN — pending-open CANCEL helper (PURE). These tests encode the WHY: when the leader closes a
 * position whose multi-tx open is still IN FLIGHT, the brain must drop EXACTLY that leader's pending-open stashes
 * across all 4 continuation maps (else a continuation deploys capital into an exited pool) and NEVER a bystander's
 * (else an unrelated in-flight open is wrongly cancelled). The stash keys and leader→pool mapping are the whole of
 * the cancel decision, so they are locked here without booting the engine.
 */
import { describe, expect, it } from 'vitest';
import { type PendingOpenMaps, pendingOpenLeaders, pendingStashesFor, stashCount } from './pending-open-cancel';

const LEADER_A = 'LeaderPosA';
const LEADER_B = 'LeaderPosB';
const POOL_A = 'PoolA';
const POOL_B = 'PoolB';

/** Build the 4 maps with one entry per map for LEADER_A and one bystander (LEADER_B) in each. */
function mapsWithBoth(): PendingOpenMaps {
  return {
    // two-sided / Token-2022-deposit maps stash the originating event (e.position is the leader).
    twoSidedOpens: new Map([
      ['buy-a', { e: { position: LEADER_A, pool: POOL_A } }],
      ['buy-b', { e: { position: LEADER_B, pool: POOL_B } }],
    ]),
    token2022Deposits: new Map([
      ['create-a', { e: { position: LEADER_A, pool: POOL_A } }],
      ['create-b', { e: { position: LEADER_B, pool: POOL_B } }],
    ]),
    // deposit-mirror / reshape-add maps stash leaderPosition directly.
    token2022Mirrors: new Map([
      ['deposit-a', { leaderPosition: LEADER_A, pool: POOL_A }],
      ['deposit-b', { leaderPosition: LEADER_B, pool: POOL_B }],
    ]),
    reshapeAdds: new Map([
      ['reshape-a', { leaderPosition: LEADER_A, pool: POOL_A }],
      ['reshape-b', { leaderPosition: LEADER_B, pool: POOL_B }],
    ]),
  };
}

describe('pendingStashesFor', () => {
  it('returns the LEADER_A key from every one of the 4 maps and no bystander key', () => {
    // WHY: a cancel must reach the leader-closed position's stash in whichever map(s) its multi-tx open landed in,
    // and MUST NOT drop an unrelated in-flight open — cancelling a bystander would abandon a valid copy.
    const keys = pendingStashesFor(LEADER_A, mapsWithBoth());
    expect(keys.twoSidedOpens).toEqual(['buy-a']);
    expect(keys.token2022Deposits).toEqual(['create-a']);
    expect(keys.token2022Mirrors).toEqual(['deposit-a']);
    expect(keys.reshapeAdds).toEqual(['reshape-a']);
    expect(stashCount(keys)).toBe(4);
  });

  it('returns nothing when the leader position has no in-flight open', () => {
    const keys = pendingStashesFor('SomeoneElse', mapsWithBoth());
    expect(stashCount(keys)).toBe(0);
  });

  it('collects MULTIPLE keys within one map for the same leader (e.g. re-detected/duplicate stashes)', () => {
    const maps: PendingOpenMaps = {
      twoSidedOpens: new Map([
        ['buy-a1', { e: { position: LEADER_A, pool: POOL_A } }],
        ['buy-a2', { e: { position: LEADER_A, pool: POOL_A } }],
      ]),
      token2022Deposits: new Map(),
      token2022Mirrors: new Map(),
      reshapeAdds: new Map(),
    };
    expect(pendingStashesFor(LEADER_A, maps).twoSidedOpens.sort()).toEqual(['buy-a1', 'buy-a2']);
  });
});

describe('pendingOpenLeaders', () => {
  it('maps each distinct in-flight leader position to its pool across all 4 maps', () => {
    // WHY: the reconcile backstop needs the pool to emit the cancel event; the map must dedup a leader present in
    // several maps to a single entry (one cancel, not four).
    const leaders = pendingOpenLeaders(mapsWithBoth());
    expect(leaders.get(LEADER_A)).toBe(POOL_A);
    expect(leaders.get(LEADER_B)).toBe(POOL_B);
    expect(leaders.size).toBe(2);
  });

  it('is empty when there are no in-flight opens', () => {
    const empty: PendingOpenMaps = { twoSidedOpens: new Map(), token2022Deposits: new Map(), token2022Mirrors: new Map(), reshapeAdds: new Map() };
    expect(pendingOpenLeaders(empty).size).toBe(0);
  });
});

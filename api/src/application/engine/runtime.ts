import type { OpenPosition } from '@meteora/shared';
import type { OnchainValued, SnapshotPlan } from '@/domain/dlmm';
import type { PoolRef } from '@/domain/ports';

export interface WalletRuntime {
  address: string;
  pools: PoolRef[];
  open: Map<string, OpenPosition>;
  lastPollAt: number;
  lastPollOk: boolean;
  pollIntervalMs: number;
  refreshing: boolean;
  reconciled: boolean;
  /** Authoritative, slot-consistent valuation from the on-chain snapshot (null until first snapshot). */
  onchain: OnchainValued | null;
  lastSnapshotAt: number;
  snapshotting: boolean;
  lastClosedSyncAt: number;
  /** Layer A: cached snapshot discovery plan (position set + ranges). Null until first discovery. */
  snapshotPlan: SnapshotPlan | null;
  /** Set when a WS open/close/add/remove may have changed the position set/ranges → re-discover. */
  needsDiscovery: boolean;
  lastDiscoveryAt: number;
  /** on-chain positions source: force a projection→positions sync on the next snapshot (set on activity). */
  needsSync: boolean;
  lastSyncAt: number;
  /** on-chain positions source: last delta-ingest time (drives the dropped-WS-event backstop sweep). */
  lastIngestAt: number;
  /** on-chain positions source: closed-position count at the last full reproject — emit closed_changed
   *  only when this actually moves (−1 = never reprojected, so the first reproject always notifies). */
  lastClosedCount: number;
  /** on-chain positions source: txs ingested so far during the initial backfill — drives the UI's
   *  "indexing… (N txs)" onboarding state. `reconciled` flips true once the first projection lands. */
  ingestedTxs: number;
}

export function makeRuntime(address: string, openPositions: OpenPosition[]): WalletRuntime {
  const open = new Map<string, OpenPosition>();
  for (const p of openPositions) open.set(p.positionAddress, p);
  return {
    address,
    pools: [],
    open,
    lastPollAt: 0,
    lastPollOk: false,
    pollIntervalMs: 0,
    refreshing: false,
    reconciled: false,
    onchain: null,
    lastSnapshotAt: 0,
    snapshotting: false,
    lastClosedSyncAt: Date.now(),
    snapshotPlan: null,
    needsDiscovery: true,
    lastDiscoveryAt: 0,
    needsSync: false,
    lastSyncAt: 0,
    lastIngestAt: 0,
    lastClosedCount: -1,
    ingestedTxs: 0,
  };
}

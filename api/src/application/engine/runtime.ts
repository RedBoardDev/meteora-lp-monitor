import type { OpenPosition } from '@meteora/shared';
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
  idleConfirmed: number;
  // Net capital delta from in-flight events not yet reflected on-chain. See currentIdle().
  pendingDelta: number;
  pendingSince: number;
  lastBalanceAt: number;
  lastClosedSyncAt: number;
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
    idleConfirmed: 0,
    pendingDelta: 0,
    pendingSince: 0,
    lastBalanceAt: 0,
    lastClosedSyncAt: Date.now(),
  };
}

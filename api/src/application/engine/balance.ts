import type { BalanceGateway } from '@/domain/ports';
import type { WalletRuntime } from './runtime';

const PENDING_BALANCE_TTL_MS = 60_000;

export function currentIdle(rt: WalletRuntime): number {
  const pending = Date.now() - rt.pendingSince < PENDING_BALANCE_TTL_MS ? rt.pendingDelta : 0;
  return Math.max(0, rt.idleConfirmed + pending);
}

export async function refreshBalance(
  rt: WalletRuntime,
  balances: BalanceGateway,
  onDone: () => void,
): Promise<void> {
  rt.lastBalanceAt = Date.now();
  const fresh = await balances.getIdleSol(rt.address);
  // Once the RPC balance reflects the in-flight move, fold the delta in to avoid double-counting.
  if (rt.pendingDelta !== 0 && Math.abs(fresh - rt.idleConfirmed) >= Math.abs(rt.pendingDelta) / 2) {
    rt.pendingDelta = 0;
  }
  rt.idleConfirmed = fresh;
  onDone();
}

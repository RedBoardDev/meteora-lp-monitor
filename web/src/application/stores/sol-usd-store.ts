import { create } from 'zustand';
import { api } from '@/infrastructure/api/client';

type SolUsdState = {
  /** SOL spot price in USD, or null until first loaded / when unavailable. */
  rate: number | null;
  refresh: () => Promise<void>;
};

/** Live SOL/USD rate for the display-currency toggle. Shared across the app (one fetch, many readers);
 *  the rate barely moves, so app-shell polls it ~once a minute. */
export const useSolUsd = create<SolUsdState>((set) => ({
  rate: null,
  refresh: async () => {
    try {
      const { price } = await api.solUsd();
      if (price != null && Number.isFinite(price) && price > 0) set({ rate: price });
    } catch {
      /* keep the last known rate on a transient failure */
    }
  },
}));

/** Start polling the SOL/USD rate; returns a stop function (call on unmount). */
export function startSolUsdPolling(intervalMs = 60_000): () => void {
  const { refresh } = useSolUsd.getState();
  void refresh();
  const timer = setInterval(() => void refresh(), intervalMs);
  return () => clearInterval(timer);
}

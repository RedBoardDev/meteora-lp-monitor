import type { Wallet } from '@binsight/shared';
import { create } from 'zustand';
import { api } from '@/infrastructure/api/client';

/**
 * Single source for the watchlist + each wallet's onboarding status (`ready` / `indexedTxs`), shared by
 * the scope selector, the settings drawer and the indexing banner — so /wallets is fetched once, not
 * per component. While any wallet is still indexing its history, it self-polls so the "indexing…" state
 * clears the moment the backfill completes (no dedicated socket message needed).
 */
type WalletsState = {
  wallets: Wallet[];
  loaded: boolean;
  refresh: () => Promise<void>;
  stop: () => void;
};

const POLL_MS = 3000;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const stopPoll = () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
};

export const useWallets = create<WalletsState>((set, get) => ({
  wallets: [],
  loaded: false,
  refresh: async () => {
    const wallets = await api.wallets().catch(() => get().wallets);
    set({ wallets, loaded: true });
    // Poll only while something is indexing; stop as soon as everything is ready.
    const indexing = wallets.some((w) => w.ready === false);
    if (indexing && !pollTimer) pollTimer = setInterval(() => void get().refresh(), POLL_MS);
    else if (!indexing) stopPoll();
  },
  // Stop polling + drop state on teardown (logout / dashboard unmount) so the timer can't 401-loop.
  stop: () => {
    stopPoll();
    set({ wallets: [], loaded: false });
  },
}));

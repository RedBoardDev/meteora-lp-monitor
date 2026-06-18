import type { Health, WalletState } from '@meteora/shared';
import { create } from 'zustand';
import { Portfolio } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { LiveClient } from '@/infrastructure/realtime/live-client';

type PortfolioState = {
  portfolio: Portfolio | null;
  health: Health | null;
  connected: boolean;
  scope: string;
  /** True between a scope switch and the new scope's first payload — so the UI can DIM the previous
   *  scope's data (kept on screen) instead of blanking to skeletons on every wallet switch. */
  scopeLoading: boolean;
  /** Bumped whenever a position closes — components key their closed/stats refetch on it. */
  closedVersion: number;
  start: () => void;
  stop: () => void;
  setScope: (scope: string) => void;
};

// The live socket lives outside the store (not serializable, single instance per session).
let client: LiveClient | null = null;

export const usePortfolio = create<PortfolioState>((set, get) => {
  // Apply a WalletState only if it still matches the active scope (drops stale/out-of-order payloads).
  const setIfCurrent = (s: WalletState) => {
    if (s.scope === get().scope) set({ portfolio: new Portfolio(s), scopeLoading: false });
  };

  const applyState = (scope: string) =>
    api
      .state(scope)
      .then(setIfCurrent)
      // On REST failure, clear scopeLoading ONLY if this scope is still current — otherwise it could
      // stick `true` forever when no matching socket payload arrives (a stale failure must not clobber
      // a newer scope's loading state).
      .catch(() => {
        if (get().scope === scope) set({ scopeLoading: false });
      });

  return {
    portfolio: null,
    health: null,
    connected: false,
    scope: 'all',
    scopeLoading: false,
    closedVersion: 0,

    start: () => {
      if (client) return;
      client = new LiveClient({
        onState: setIfCurrent,
        onHealth: (health) => set({ health }),
        // Live events don't bump the closed/stats refetch — the server emits a dedicated
        // closed_changed (onClosedChanged) when a position actually closes.
        onEvent: () => {},
        onClosedChanged: () => set((st) => ({ closedVersion: st.closedVersion + 1 })),
        onConnectionChange: (connected) => set({ connected }),
      });
      void client.connect(get().scope);
      void applyState(get().scope); // fast first paint before the socket opens
    },

    stop: () => {
      client?.disconnect();
      client = null;
      set({ connected: false });
    },

    setScope: (scope) => {
      if (scope === get().scope) return;
      // Keep the previous scope's data on screen (dimmed via scopeLoading) — no blank-to-skeleton on
      // every wallet switch. setIfCurrent clears scopeLoading once the new scope's payload lands.
      set({ scope, scopeLoading: true });
      client?.subscribe(scope);
      void applyState(scope);
    },
  };
});

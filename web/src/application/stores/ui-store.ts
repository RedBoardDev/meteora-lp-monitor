import type { ClosedPosition } from '@binsight/shared';
import { create } from 'zustand';
import type { Period } from '@/domain/period';

export type SelectedPosition = {
  address: string;
  pair: string;
  open: boolean;
  /** Snapshot of a closed position's figures (for the drawer summary). */
  closed?: ClosedPosition;
} | null;

/** Top-level dashboard view. Default 'positions' so a reload lands straight on the live positions. */
export type Tab = 'positions' | 'stats' | 'history';

type UiState = {
  selected: SelectedPosition;
  select: (selected: SelectedPosition) => void;
  /** Shared time window for the performance stats + profit chart. */
  period: Period;
  setPeriod: (period: Period) => void;
  /** Active top-level tab (transient — every reload starts on Positions). */
  tab: Tab;
  setTab: (tab: Tab) => void;
  /** A token filter pushed into the History search from elsewhere (clicking a Stats pair). The
   *  History table syncs its search box to this whenever it changes. */
  historyQuery: string;
  /** Jump to History filtered by a token — one call from any clickable pair/token. */
  filterByToken: (token: string) => void;
  /** Settings drawer (lifted so the empty-state CTA can open it, not just the header button). */
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
};

/** Transient UI state — open drawer + the shared stats/chart time window + the active tab. */
export const useUi = create<UiState>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
  period: '1m',
  setPeriod: (period) => set({ period }),
  tab: 'positions',
  setTab: (tab) => set({ tab }),
  historyQuery: '',
  filterByToken: (token) => set({ historyQuery: token, tab: 'history' }),
  settingsOpen: false,
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
}));

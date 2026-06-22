import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/** Display currency for money values. USD multiplies SOL by the live SOL/USD rate. */
type Currency = 'SOL' | 'USD';

type PrefsState = {
  /** Mask every money value as asterisks — for screenshots / sharing the curve publicly. */
  hideAmounts: boolean;
  toggleHideAmounts: () => void;
  /** Render amounts in SOL (native) or converted to USD. */
  currency: Currency;
  setCurrency: (currency: Currency) => void;
};

/**
 * Persisted display preferences (survive reloads). The single reactive seam both the "hide amounts"
 * privacy toggle and the SOL⇄USD switch read from — money components subscribe and re-render on change.
 * `persist` is SSR-safe (no-op on the server, hydrates on the client).
 */
export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      hideAmounts: false,
      toggleHideAmounts: () => set((s) => ({ hideAmounts: !s.hideAmounts })),
      currency: 'SOL',
      setCurrency: (currency) => set({ currency }),
    }),
    { name: 'mlm-prefs' },
  ),
);

/** The mask shown in place of a hidden money value. */
export const AMOUNT_MASK = '****';

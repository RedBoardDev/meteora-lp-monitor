import { create } from 'zustand';
import { type AccountIdentity, api } from '@/infrastructure/api/client';

type IdentityState = {
  identity: AccountIdentity | null;
  loaded: boolean;
  /** Fetch the caller's identity once (address + owner flag). Idempotent. */
  load: () => Promise<void>;
};

/** The signed-in account's identity — drives the owner-only Admin entry and any future identity UI. */
export const useIdentity = create<IdentityState>((set, get) => ({
  identity: null,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      set({ identity: await api.me(), loaded: true });
    } catch {
      set({ identity: null, loaded: true });
    }
  },
}));

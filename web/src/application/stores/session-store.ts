import { create } from 'zustand';
import { authApi } from '@/infrastructure/api/client';

type SessionState = {
  authed: boolean;
  /** Address + password sign-in (no signature). */
  login: (address: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  /** Flip the client flag after a register / reset flow has set the session cookie server-side. */
  setAuthed: (v: boolean) => void;
  logout: () => Promise<void>;
};

/**
 * Client-side session flag. The source of truth is the httpOnly cookie (gated server-side on the
 * dashboard route); this store only tracks login/logout transitions for the client UI. Register and
 * password-reset are multi-step (nonce → wallet signature → submit) and orchestrated in the auth page,
 * which then calls {@link setAuthed} once the cookie is set.
 */
export const useSession = create<SessionState>((set) => ({
  authed: false,
  login: async (address, password) => {
    const res = await authApi.login(address, password);
    if (res.ok) set({ authed: true });
    return res;
  },
  setAuthed: (v) => set({ authed: v }),
  logout: async () => {
    await authApi.logout();
    set({ authed: false });
  },
}));

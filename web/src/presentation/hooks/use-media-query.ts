'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * SSR-safe media-query subscription via {@link useSyncExternalStore}. On the server (and the very
 * first client render before hydration) the server snapshot is returned — see {@link useMounted}
 * for gating UI that must not flash between the server default and the resolved client value.
 */
export function useMediaQuery(query: string, serverSnapshot = false): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => serverSnapshot,
  );
}

/** The single mobile/desktop divide for the whole app: below Tailwind's `md` (768px) = mobile. */
export const MOBILE_BREAKPOINT = 768;

/**
 * True on phone-sized viewports (< 768px). The one fork point between the desktop composition and
 * the dedicated mobile tree. Server snapshot defaults to desktop (false) — gate with
 * {@link useMounted} where a first-paint flash would be visible.
 */
export function useIsMobile(): boolean {
  return !useMediaQuery(`(min-width: ${MOBILE_BREAKPOINT}px)`, true);
}

/** False on the server and the first client render, true thereafter — used to avoid hydration flash. */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

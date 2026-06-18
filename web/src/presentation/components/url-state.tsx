'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { api } from '@/infrastructure/api/client';

const SCOPE_KEY = 'mlpm-scope';

/**
 * Keeps the URL (`?address`, `?positionId`), localStorage (last scope), and the stores in sync —
 * LPAgent-style shareable / bookmarkable / deep-linkable links.
 *
 * - On mount (one-shot): restore the scope from `?address` → localStorage → 'all', and remember a
 *   `?positionId` to open once its data is available.
 * - On change: reflect scope + the open drawer into the URL via `history.replaceState` (no Next
 *   navigation → no server round-trip, no history spam, no feedback loop) and persist the scope.
 *
 * Reads are guarded by refs so they run once; writes never feed back into the read (we don't depend
 * on `useSearchParams` after mount), which keeps the whole thing loop-free and stable.
 */
export function UrlState() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setScope = usePortfolio((s) => s.setScope);
  const scope = usePortfolio((s) => s.scope);
  const portfolio = usePortfolio((s) => s.portfolio);
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);

  const pendingPos = useRef<string | null>(null);
  const firstWrite = useRef(true);

  // 1) One-shot restore from the URL, falling back to the last-used scope in localStorage.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate once-on-mount restore.
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(SCOPE_KEY);
    } catch {}
    const addr = searchParams.get('address') ?? stored;
    if (addr && addr !== 'all') setScope(addr);
    const pos = searchParams.get('positionId');
    if (pos) pendingPos.current = pos;
  }, []);

  // 2) Resolve a pending `?positionId` once data is available: an open position from the live
  //    portfolio, otherwise a single closed fetch. Best-effort — a stale link just opens nothing.
  useEffect(() => {
    const pos = pendingPos.current;
    if (!pos || !portfolio) return;
    const open = portfolio.open.find((p) => p.address === pos);
    pendingPos.current = null;
    if (open) {
      select({ address: pos, pair: open.pair, open: true });
      return;
    }
    api
      .position(pos)
      .then((res) => {
        if (res.closed) {
          const c = res.closed;
          select({ address: pos, pair: `${c.tokenX}/${c.tokenY}`, open: false, closed: c });
        }
      })
      .catch(() => {});
  }, [portfolio, select]);

  // 3) Drop a stale/unknown `?address` that isn't one of the configured wallets.
  useEffect(() => {
    let cancelled = false;
    api
      .wallets()
      .then((ws) => {
        if (cancelled) return;
        const cur = usePortfolio.getState().scope;
        if (cur !== 'all' && !ws.some((w) => w.address === cur)) setScope('all');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [setScope]);

  // 4) Reflect scope + the open drawer into the URL. Skip the very first run (so effect 1 reads the
  //    incoming URL before we write) and hold off while a deep-linked position is still resolving
  //    (so we don't strip its `?positionId` before the drawer opens).
  useEffect(() => {
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    if (pendingPos.current) return;
    const params = new URLSearchParams();
    if (scope !== 'all') params.set('address', scope);
    if (selected) params.set('positionId', selected.address);
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `${pathname}?${qs}` : pathname);
  }, [scope, selected, pathname]);

  // 5) Persist the active scope so a plain reload (no URL params) restores the last wallet.
  useEffect(() => {
    try {
      if (scope === 'all') localStorage.removeItem(SCOPE_KEY);
      else localStorage.setItem(SCOPE_KEY, scope);
    } catch {}
  }, [scope]);

  return null;
}

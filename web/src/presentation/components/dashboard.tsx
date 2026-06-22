'use client';

import { Suspense, useEffect } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { startSolUsdPolling } from '@/application/stores/sol-usd-store';
import { useWallets } from '@/application/stores/wallets-store';
import { useIsMobile, useMounted } from '@/presentation/hooks/use-media-query';
import { MobileApp } from '@/presentation/mobile/mobile-app';
import { DesktopShell } from './desktop-shell';
import { UrlState } from './url-state';

/**
 * Single fork point between the frozen desktop composition ({@link DesktopShell}) and the dedicated
 * mobile tree ({@link MobileApp}). Owns all shared bootstrap — the portfolio live feed, the wallet
 * list refresh and the SOL/USD poll — so neither shell duplicates it. The mount gate avoids a
 * first-paint flash between the SSR default and the resolved client viewport; only the chosen
 * subtree mounts, so stores/queries are never subscribed twice.
 */
export function Dashboard() {
  const start = usePortfolio((s) => s.start);
  const stop = usePortfolio((s) => s.stop);
  const refreshWallets = useWallets((s) => s.refresh);
  const stopWallets = useWallets((s) => s.stop);
  const mounted = useMounted();
  const isMobile = useIsMobile();

  useEffect(() => {
    start();
    return () => stop();
  }, [start, stop]);

  useEffect(() => {
    void refreshWallets();
    const stopSolUsd = startSolUsdPolling();
    return () => {
      stopWallets();
      stopSolUsd();
    };
  }, [refreshWallets, stopWallets]);

  return (
    <div className="min-h-dvh">
      <Suspense fallback={null}>
        <UrlState />
      </Suspense>
      {mounted ? isMobile ? <MobileApp /> : <DesktopShell /> : null}
    </div>
  );
}

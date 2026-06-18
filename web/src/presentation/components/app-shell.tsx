'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { usePrefs } from '@/application/stores/prefs-store';
import { useSession } from '@/application/stores/session-store';
import { startSolUsdPolling, useSolUsd } from '@/application/stores/sol-usd-store';
import { useUi } from '@/application/stores/ui-store';
import { useWallets } from '@/application/stores/wallets-store';
import { shortAddr } from '@/domain/format';
import {
  Button,
  cn,
  IconEye,
  IconEyeOff,
  IconSettings,
  Segmented,
  SolMark,
} from '@/presentation/ui';
import { HealthIndicator } from './health-indicator';
import { SettingsDrawer } from './settings-drawer';

export function AppShell() {
  const router = useRouter();
  const logout = useSession((s) => s.logout);
  const scope = usePortfolio((s) => s.scope);
  const setScope = usePortfolio((s) => s.setScope);
  const wallets = useWallets((s) => s.wallets);
  const refreshWallets = useWallets((s) => s.refresh);
  const stopWallets = useWallets((s) => s.stop);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const hideAmounts = usePrefs((s) => s.hideAmounts);
  const toggleHideAmounts = usePrefs((s) => s.toggleHideAmounts);
  const currency = usePrefs((s) => s.currency);
  const setCurrency = usePrefs((s) => s.setCurrency);
  const solUsd = useSolUsd((s) => s.rate);

  useEffect(() => {
    void refreshWallets();
    const stopSolUsd = startSolUsdPolling();
    return () => {
      stopWallets();
      stopSolUsd();
    };
  }, [refreshWallets, stopWallets]);

  const options = [
    { label: 'All', value: 'all' },
    ...wallets.map((w) => ({
      // A freshly-added wallet still backfilling its history shows "indexing…" until it's queryable.
      label: `${w.label || shortAddr(w.address)}${w.ready === false ? ' · indexing…' : ''}`,
      value: w.address,
    })),
  ];

  function onWalletsChanged(removed?: string) {
    void refreshWallets();
    if (removed && removed === scope) setScope('all');
  }

  async function onLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <>
      <header className="sticky top-0 z-20 border-border border-b bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            {/* biome-ignore lint/performance/noImgElement: tiny static brand mark (Apple-squircle app icon), no layout cost */}
            <img src="/icon.svg" alt="" width={24} height={24} className="size-6 shrink-0" />
            <h1 className="whitespace-nowrap font-semibold text-sm text-text tracking-tight">
              Meteora LP Monitor
            </h1>
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            {/* Only the scope tabs scroll horizontally on mobile — the health popover (absolute,
                drops below the header) must NOT sit inside an overflow container, or it would add
                scroll to the topbar (overflow-x:auto forces overflow-y:auto). */}
            {options.length > 1 && (
              <div className="-mx-1 min-w-0 overflow-x-auto px-1">
                <Segmented options={options} value={scope} onChange={setScope} />
              </div>
            )}
            <HealthIndicator />
            {/* Cohesive toolbar of header controls (currency · privacy · settings) — one grouped,
                consistently-sized icon set rather than a row of mismatched buttons. */}
            <div className="flex items-center gap-0.5 rounded-lg bg-surface-2/50 p-0.5 ring-1 ring-border ring-inset">
              <button
                type="button"
                onClick={() => setCurrency(currency === 'SOL' ? 'USD' : 'SOL')}
                aria-label={`Display in ${currency === 'SOL' ? 'USD' : 'SOL'}`}
                title={
                  solUsd != null
                    ? `1 SOL = $${solUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })} · show in ${currency === 'SOL' ? 'USD' : 'SOL'}`
                    : `Show amounts in ${currency === 'SOL' ? 'USD' : 'SOL'}`
                }
                className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
              >
                {currency === 'SOL' ? (
                  <SolMark size={15} />
                ) : (
                  <span className="font-semibold text-[15px] leading-none">$</span>
                )}
              </button>
              <button
                type="button"
                aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'}
                aria-pressed={hideAmounts}
                title={hideAmounts ? 'Show amounts' : 'Hide amounts (for sharing)'}
                onClick={toggleHideAmounts}
                className={cn(
                  'grid size-8 place-items-center rounded-md transition-colors hover:bg-surface hover:text-text',
                  hideAmounts ? 'text-accent' : 'text-muted',
                )}
              >
                {hideAmounts ? <IconEyeOff /> : <IconEye />}
              </button>
              <button
                type="button"
                aria-label="Settings"
                onClick={() => setSettingsOpen(true)}
                className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
              >
                <IconSettings size={16} />
              </button>
            </div>
            <Button variant="ghost" onClick={onLogout} className="whitespace-nowrap px-2.5">
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        wallets={wallets}
        onChanged={onWalletsChanged}
      />
    </>
  );
}

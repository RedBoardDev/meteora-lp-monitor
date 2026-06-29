'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { useUi } from '@/application/stores/ui-store';
import { useWallets } from '@/application/stores/wallets-store';
import { EmptyWallets } from '@/presentation/components/empty-wallets';
import { useOpenAccess } from '@/presentation/components/open-access-context';
import { PositionDrawer } from '@/presentation/components/position-drawer';
import { SettingsDrawer } from '@/presentation/components/settings-drawer';
import { StatsPanel } from '@/presentation/components/stats-panel';
import { BottomTabBar } from './bottom-tab-bar';
import { MobileHistoryView } from './history-view';
import { MobileAppBar } from './mobile-app-bar';
import { MobileScopeChips } from './mobile-scope-chips';
import { MobileSummary } from './mobile-summary';
import { MobilePositionsView } from './positions-view';

/**
 * The dedicated mobile composition (< md): a compact top bar + scrollable scope chips, the active
 * tab's view, and a fixed bottom tab bar. The position detail and settings reuse the shared
 * {@link PositionDrawer} (renders as a bottom sheet on mobile) and {@link SettingsDrawer}.
 */
export function MobileApp() {
  const tab = useUi((s) => s.tab);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const scope = usePortfolio((s) => s.scope);
  const setScope = usePortfolio((s) => s.setScope);
  const wallets = useWallets((s) => s.wallets);
  const refreshWallets = useWallets((s) => s.refresh);
  const noWallets = useWallets((s) => s.loaded && s.wallets.length === 0);
  const openAccess = useOpenAccess();

  function onWalletsChanged(removed?: string) {
    void refreshWallets();
    if (removed && removed === scope) setScope('all');
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <MobileAppBar />
      {/* Open-access accounts are single-wallet — no scope chips. */}
      {!openAccess && <MobileScopeChips />}
      {/* Bottom padding clears the fixed tab bar (+ its safe-area inset). */}
      <main className="flex-1 px-4 pt-1 pb-[calc(5rem+env(safe-area-inset-bottom))]">
        {noWallets ? (
          <EmptyWallets />
        ) : (
          <div className="flex flex-col gap-4">
            {/* Global portfolio header — same on every tab, mirroring the desktop layout. */}
            <MobileSummary />
            {tab === 'positions' ? (
              <MobilePositionsView />
            ) : tab === 'stats' ? (
              <StatsPanel />
            ) : (
              <MobileHistoryView />
            )}
          </div>
        )}
      </main>
      <BottomTabBar />
      <PositionDrawer />
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        wallets={wallets}
        onChanged={onWalletsChanged}
      />
    </div>
  );
}

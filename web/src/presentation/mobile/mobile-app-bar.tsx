'use client';

import { usePrefs } from '@/application/stores/prefs-store';
import { useSolUsd } from '@/application/stores/sol-usd-store';
import { useUi } from '@/application/stores/ui-store';
import { HealthIndicator } from '@/presentation/components/health-indicator';
import { cn, IconEye, IconEyeOff, IconSettings, SolMark } from '@/presentation/ui';

/**
 * Compact mobile top bar: brand + connection health + the currency/privacy/settings controls.
 * Sticky, with safe-area top padding so it clears the notch in PWA standalone. Sign-out lives in
 * the settings drawer on mobile (it isn't surfaced here, to keep the bar uncluttered).
 */
export function MobileAppBar() {
  const setSettingsOpen = useUi((s) => s.setSettingsOpen);
  const hideAmounts = usePrefs((s) => s.hideAmounts);
  const toggleHideAmounts = usePrefs((s) => s.toggleHideAmounts);
  const currency = usePrefs((s) => s.currency);
  const setCurrency = usePrefs((s) => s.setCurrency);
  const solUsd = useSolUsd((s) => s.rate);

  return (
    <header className="sticky top-0 z-20 border-border border-b bg-bg/80 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          {/* biome-ignore lint/performance/noImgElement: tiny static brand mark, no layout cost */}
          <img src="/icon.svg" alt="" width={22} height={22} className="size-[22px] shrink-0" />
          <h1 className="font-display font-semibold text-[15px] text-text tracking-tight">
            Binsight
          </h1>
        </div>
        <div className="flex items-center gap-1">
          <HealthIndicator />
          <div className="flex items-center gap-0.5 rounded-lg bg-surface-2/50 p-0.5 ring-1 ring-border ring-inset">
            <button
              type="button"
              onClick={() => setCurrency(currency === 'SOL' ? 'USD' : 'SOL')}
              aria-label={`Display in ${currency === 'SOL' ? 'USD' : 'SOL'}`}
              title={
                solUsd != null
                  ? `1 SOL = $${solUsd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
                  : `Show amounts in ${currency === 'SOL' ? 'USD' : 'SOL'}`
              }
              className="grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
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
                'grid size-9 place-items-center rounded-md transition-colors hover:bg-surface hover:text-text',
                hideAmounts ? 'text-accent' : 'text-muted',
              )}
            >
              {hideAmounts ? <IconEyeOff /> : <IconEye />}
            </button>
            <button
              type="button"
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
              className="grid size-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface hover:text-text"
            >
              <IconSettings size={16} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

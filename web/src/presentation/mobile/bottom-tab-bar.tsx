'use client';

import type { ReactNode } from 'react';
import { type Tab, useUi } from '@/application/stores/ui-store';
import { cn, IconChartBar, IconHistory, IconLayers } from '@/presentation/ui';

const TABS: { label: string; value: Tab; Icon: (p: { size?: number }) => ReactNode }[] = [
  { label: 'Positions', value: 'positions', Icon: IconLayers },
  { label: 'Stats', value: 'stats', Icon: IconChartBar },
  { label: 'History', value: 'history', Icon: IconHistory },
];

/** Fixed mobile bottom navigation between the three top-level views, with safe-area inset padding. */
export function BottomTabBar() {
  const tab = useUi((s) => s.tab);
  const setTab = useUi((s) => s.setTab);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-border border-t bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl">
      <div className="flex">
        {TABS.map(({ label, value, Icon }) => {
          const active = tab === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 font-medium text-[11px] transition-colors',
                active ? 'text-accent' : 'text-muted active:text-text',
              )}
            >
              <Icon size={20} />
              {label}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

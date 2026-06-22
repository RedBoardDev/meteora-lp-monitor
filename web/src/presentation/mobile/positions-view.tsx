'use client';

import { usePortfolio } from '@/application/stores/portfolio-store';
import { EmptyState, IconLayers, Skeleton } from '@/presentation/ui';
import { MobilePortfolioStats } from './mobile-summary';
import { OpenPositionCard } from './position-card';
import { SectionHeader } from './section-header';

/** Mobile "Positions" tab: the widget-style portfolio header ({@link MobileSummary}) + open positions as cards. */
export function MobilePositionsView() {
  const portfolio = usePortfolio((s) => s.portfolio);
  const rows = portfolio?.openByValue ?? [];
  const now = Date.now();

  return (
    <div className="flex flex-col gap-4">
      <MobilePortfolioStats />
      <section className="flex flex-col gap-2.5">
        <SectionHeader title="Open positions" count={portfolio ? rows.length : undefined} />
        {!portfolio ? (
          <CardSkeletons />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<IconLayers size={18} />}
            title="No open positions"
            hint="Active Meteora LP positions appear here live."
          />
        ) : (
          rows.map((p) => <OpenPositionCard key={p.address} p={p} now={now} />)
        )}
      </section>
    </div>
  );
}

function CardSkeletons() {
  return (
    <>
      <Skeleton className="h-[4.75rem] w-full rounded-xl" />
      <Skeleton className="h-[4.75rem] w-full rounded-xl" />
      <Skeleton className="h-[4.75rem] w-full rounded-xl" />
    </>
  );
}

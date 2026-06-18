'use client';

import type { Bucket } from '@meteora/shared';
import { useState } from 'react';
import { FilterBar } from './filter-bar';
import { PerformanceCard } from './performance-card';
import { ProfitChart } from './profit-chart';

/** The "Stats" tab — a clear filter row above the realized-performance stats and the profit chart.
 *  Only mounted when the tab is open, so its api.stats / api.profitHistory fetches never run on a
 *  plain reload (which lands on Positions). */
export function StatsPanel() {
  const [bucket, setBucket] = useState<Bucket>('day');
  return (
    <div className="flex flex-col gap-5">
      <FilterBar bucket={bucket} onBucket={setBucket} />
      <PerformanceCard />
      <ProfitChart bucket={bucket} />
    </div>
  );
}

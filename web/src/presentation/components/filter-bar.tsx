'use client';

import type { Bucket } from '@binsight/shared';
import { useUi } from '@/application/stores/ui-store';
import { PERIOD_OPTIONS } from '@/domain/period';
import { Segmented } from '@/presentation/ui';

const BUCKETS: { label: string; value: Bucket }[] = [
  { label: 'Day', value: 'day' },
  { label: 'Week', value: 'week' },
  { label: 'Month', value: 'month' },
];

/** Clearly-labelled time controls (LPAgent-style grouped pills): the chart bucket + the stats range. */
export function FilterBar({ bucket, onBucket }: { bucket: Bucket; onBucket: (b: Bucket) => void }) {
  const period = useUi((s) => s.period);
  const setPeriod = useUi((s) => s.setPeriod);
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
      <div className="flex items-center gap-2">
        <span className="font-medium text-faint text-xs uppercase tracking-wide">Interval</span>
        <Segmented options={BUCKETS} value={bucket} onChange={onBucket} />
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium text-faint text-xs uppercase tracking-wide">Range</span>
        <Segmented options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
      </div>
    </div>
  );
}

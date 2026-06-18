'use client';

import type { PositionEvent, RangeStatus } from '@meteora/shared';
import { type Chart, dispose, init, LineType } from 'klinecharts';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/infrastructure/api/client';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import { cn, EmptyState, IconClose, Skeleton } from '@/presentation/ui';

export type PositionChartInput = {
  positionAddress: string;
  poolAddress: string;
  tokenX: string;
  tokenMint: string;
  minPrice?: number;
  maxPrice?: number;
  /** Open positions carry a live range status; closed ones don't. */
  rangeStatus?: RangeStatus;
  openedAt: number | null;
  closedAt: number | null;
};

const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
type Timeframe = (typeof TIMEFRAMES)[number];

const cssVar = (name: string, fallback: string): string =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

/** Short marker label per lifecycle event (kept terse so the timeline stays uncluttered). */
const EVENT_LABEL: Partial<Record<PositionEvent['kind'], string>> = {
  open: 'Open',
  deposit: 'Add',
  withdraw: 'Remove',
  claim: 'Fee',
  close: 'Close',
};

export function PositionChart(props: PositionChartInput) {
  const { poolAddress, positionAddress } = props;
  const [tf, setTf] = useState<Timeframe>('15m');
  const [full, setFull] = useState(false);

  const candles = useScopedQuery(() => api.ohlcv(poolAddress, tf), [poolAddress, tf]);
  const history = useScopedQuery(() => api.history(positionAddress), [positionAddress]);
  const hasCandles = (candles.data?.candles.length ?? 0) > 0;

  return (
    <div
      className={cn(
        'border-border border-t bg-bg',
        full && 'fixed inset-0 z-50 flex flex-col border-0',
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-0.5">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTf(t)}
              className={cn(
                'rounded px-2 py-1 text-xs tabular-nums transition-colors',
                t === tf ? 'bg-surface-2 text-text' : 'text-faint hover:text-text',
              )}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setFull((v) => !v)}
          className="rounded p-1 text-faint transition-colors hover:text-text"
          aria-label={full ? 'Exit fullscreen' : 'Fullscreen'}
          title={full ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {full ? <IconClose size={16} /> : <ExpandGlyph />}
        </button>
      </div>

      {candles.loading ? (
        <Skeleton className={cn('w-full', full ? 'flex-1' : 'h-[28rem]')} />
      ) : hasCandles ? (
        <KChart
          {...props}
          candles={candles.data?.candles ?? []}
          events={history.data?.events ?? []}
          full={full}
        />
      ) : candles.error ? (
        <EmptyState variant="error" title="Couldn't load chart" onRetry={candles.refetch} />
      ) : (
        // Brand-new pool GeckoTerminal hasn't indexed yet → fall back to the dexscreener embed.
        <EmbedFallback poolAddress={poolAddress} full={full} />
      )}
    </div>
  );
}

function KChart({
  candles,
  events,
  minPrice,
  maxPrice,
  rangeStatus,
  full,
}: PositionChartInput & {
  candles: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[];
  events: PositionEvent[];
  full: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const up = cssVar('--color-in-range', '#34d399');
    const down = cssVar('--color-out-range', '#f87171');
    const grid = cssVar('--color-border', '#27272a');
    const axisText = cssVar('--color-faint', '#71717a');
    const band = rangeStatus === 'in' ? up : cssVar('--color-accent', '#bef264');

    const chart = init(el, {
      locale: 'en-US',
      styles: {
        grid: { horizontal: { color: grid }, vertical: { show: false } },
        candle: {
          bar: {
            upColor: up,
            downColor: down,
            noChangeColor: axisText,
            upBorderColor: up,
            downBorderColor: down,
            upWickColor: up,
            downWickColor: down,
          },
          priceMark: {
            high: { color: axisText },
            low: { color: axisText },
            last: { text: { size: 11 } },
          },
        },
        xAxis: {
          axisLine: { color: grid },
          tickLine: { color: grid },
          tickText: { color: axisText },
        },
        yAxis: {
          axisLine: { color: grid },
          tickLine: { color: grid },
          tickText: { color: axisText },
        },
        separator: { color: grid },
        crosshair: {
          horizontal: { text: { backgroundColor: grid } },
          vertical: { text: { backgroundColor: grid } },
        },
        indicator: { lastValueMark: { show: false } },
        // Kill KLineChart's default blue (#1677FF) on overlays — theme the range lines + markers.
        overlay: {
          point: {
            color: band,
            borderColor: 'transparent',
            activeColor: band,
            activeBorderColor: 'transparent',
            radius: 3,
          },
          line: { color: band, size: 1 },
          polygon: { color: band, borderColor: band },
          arc: { color: band },
          text: { color: axisText, backgroundColor: 'transparent', size: 10 },
          rectText: {
            color: cssVar('--color-text', '#e5e5e5'),
            backgroundColor: cssVar('--color-surface-2', '#26282e'),
            borderColor: band,
            borderSize: 1,
            borderRadius: 2,
            paddingLeft: 4,
            paddingRight: 4,
            paddingTop: 2,
            paddingBottom: 2,
          },
        },
      },
    });
    if (!chart) return;
    chartRef.current = chart;
    // Memecoin prices are tiny (1e-5…1e-9); at the default 2-decimal precision KLineChart rounds them
    // to 0.00 and the y-axis collapses (candles vanish). Adapt the precision to the data's magnitude.
    const lows = candles.map((c) => c.low).filter((v) => v > 0);
    const minPx = lows.length > 0 ? Math.min(...lows) : 1;
    const precision = Math.min(16, Math.max(2, Math.ceil(-Math.log10(minPx)) + 3));
    chart.setPriceVolumePrecision(precision, 0);
    // VOL bars only (drop the default MA5/10/20 lines — keep it clean).
    chart.createIndicator({ name: 'VOL', calcParams: [] }, false, { id: 'pane_vol' });
    chart.applyNewData(
      candles.map((c) => ({
        timestamp: c.time * 1000,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    );

    // Range band: dashed Upper/Lower lines (KLineChart labels them with the value on the y-axis).
    const priceLine = (value: number) =>
      chart.createOverlay({
        name: 'priceLine',
        lock: true,
        points: [{ value }],
        styles: { line: { color: band, style: LineType.Dashed, size: 1 }, text: { color: band } },
      });
    if (maxPrice) priceLine(maxPrice);
    if (minPrice) priceLine(minPrice);

    // Lifecycle markers — ONE per candle. Events are bucketed by candle TIME and collapsed to the
    // dominant action (close > open > remove > add > claim) — otherwise the labels stack on the same
    // bar and become an illegible mush. Colour-coded, no blue.
    const byTime = new Map(candles.map((c) => [c.time, c]));
    const accent = cssVar('--color-accent', '#bef264');
    const PRIORITY: Record<string, number> = {
      close: 5,
      open: 4,
      withdraw: 3,
      deposit: 2,
      claim: 1,
    };
    const byBucket = new Map<number, { e: PositionEvent; value: number }>();
    for (const e of events) {
      if (!EVENT_LABEL[e.kind]) continue;
      const sec = Math.floor(e.at / 1000);
      const candle = byTime.get(sec) ?? nearestCandle(candles, sec);
      const key = candle ? candle.time : sec;
      const value = candle ? candle.high : (maxPrice ?? 0);
      const prev = byBucket.get(key);
      if (!prev || (PRIORITY[e.kind] ?? 0) > (PRIORITY[prev.e.kind] ?? 0)) {
        byBucket.set(key, { e, value });
      }
    }
    for (const { e, value } of byBucket.values()) {
      const label = EVENT_LABEL[e.kind];
      const color =
        e.kind === 'close' || e.kind === 'withdraw' ? down : e.kind === 'claim' ? accent : up;
      chart.createOverlay({
        name: 'simpleAnnotation',
        lock: true,
        points: [{ timestamp: e.at, value }],
        extendData: label,
        styles: {
          text: { color, backgroundColor: 'transparent', size: 10 },
          polygon: { color },
          line: { color },
        },
      });
    }

    return () => {
      dispose(el);
      chartRef.current = null;
    };
  }, [candles, events, minPrice, maxPrice, rangeStatus]);

  // Container resizes when toggling fullscreen → tell KLineChart to re-measure.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `full` is the intentional trigger.
  useEffect(() => {
    chartRef.current?.resize();
  }, [full]);

  return <div ref={ref} className={cn('w-full', full ? 'flex-1' : 'h-[28rem]')} />;
}

/** Closest candle to a unix-second time (events rarely align exactly to a bar boundary). */
function nearestCandle<T extends { time: number }>(candles: T[], sec: number): T | undefined {
  let best: T | undefined;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const c of candles) {
    const d = Math.abs(c.time - sec);
    if (d < bestDelta) {
      bestDelta = d;
      best = c;
    }
  }
  return best;
}

function EmbedFallback({ poolAddress, full }: { poolAddress: string; full: boolean }) {
  return (
    <iframe
      title="Price chart"
      loading="lazy"
      src={`https://dexscreener.com/solana/${poolAddress}?embed=1&theme=dark&trades=0&info=0`}
      className={cn('w-full', full ? 'flex-1' : 'h-[28rem]')}
    />
  );
}

function ExpandGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3m13 5h3a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

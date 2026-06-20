'use client';

import type { Bucket, ProfitBucket } from '@binsight/shared';
import { useRef, useState } from 'react';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { AMOUNT_MASK, usePrefs } from '@/application/stores/prefs-store';
import { useUi } from '@/application/stores/ui-store';
import { fmtDate, fmtSolSigned } from '@/domain/format';
import { periodDays, sinceMs } from '@/domain/period';
import { type Tone, toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { linePath, type Point, scale } from '@/presentation/charts/svg';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import {
  Card,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  IconShare,
  Segmented,
  Skeleton,
  SolAmount,
  Tooltip,
  toneText,
} from '@/presentation/ui';
import { ImageShareModal } from './image-share-modal';

/** Which view:
 *  • networth  = the wallet VALUE (on-chain cash + open positions; ≥0, never negative).
 *  • pnl       = the REAL PnL = performance net of apports (deposits/withdrawals); CAN be negative.
 *  • positions = per-position close PnL (Meteora, LPAgent-style). */
type Source = 'networth' | 'pnl' | 'positions';

const W = 1000;
const H = 300;
const PAD = { top: 16, right: 12, bottom: 18, left: 48 };

function fmtTick(t: number): string {
  const a = Math.abs(t);
  if (a === 0) return '0';
  if (a >= 100) return t.toFixed(0);
  if (a >= 1) return (Math.round(t * 10) / 10).toString();
  return t.toFixed(2);
}

/** ~`count` human-friendly tick values spanning [min,max] (1 / 2 / 5 ×10ⁿ steps). */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (min === max) return [min];
  const step0 = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const n = step0 / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) {
    ticks.push(Math.abs(t) < step * 1e-6 ? 0 : t);
  }
  return ticks;
}

/** Card / share title for the selected source. */
function sourceTitle(source: Source): string {
  return source === 'networth' ? 'Net Worth' : source === 'pnl' ? 'Real PnL' : 'Positions PnL';
}

/** Explanatory note under the chart for the selected source. */
function sourceNote(source: Source): string {
  if (source === 'networth')
    return 'Net Worth = la VALEUR de ton wallet (cash + positions). Tombe à 0 si tu vides, jamais négatif.';
  if (source === 'pnl')
    return 'PnL réel = ta perf nette de tes apports/retraits. Peut être négatif (ex: tu as injecté plus que ta valeur actuelle). Vérifié on-chain.';
  return 'Realized PnL per closed position (Meteora close value, LPAgent-style). Bars = each period; line = running total. Note: per-position close values can differ from the real wallet cash.';
}

export function ProfitChart({ bucket }: { bucket: Bucket }) {
  const scope = usePortfolio((s) => s.scope);
  const closedVersion = usePortfolio((s) => s.closedVersion);
  const netWorth = usePortfolio((s) => s.portfolio?.totals.walletTotalSol ?? 0);
  const period = useUi((s) => s.period);
  const [source, setSource] = useState<Source>('networth');

  // Three self-consistent views (toggle):
  //  • Net Worth = the wallet VALUE per UTC day (on-chain cash + capital deployed in open positions),
  //                reconstructed on-chain. The line is the day-by-day value; `realized` carries the
  //                day-over-day delta. No bars (the line IS the value). ≥0 — never negative.
  //  • PnL       = the REAL PnL per UTC day = performance NET of apports (deposits/withdrawals). The line
  //                is `p.realPnl`; `realized` carries its day-over-day delta. CAN be negative.
  //  • Positions = per-position close PnL (Meteora, LPAgent-style): bars per bucket + a cumulative
  //                line that is just the running sum of those bars.
  const { data, loading, stale, error, refetch } = useScopedQuery<ProfitBucket[]>(async () => {
    if (source === 'networth' || source === 'pnl') {
      const curve = await api.networthCurve(scope, periodDays(period, Date.now()));
      const pts = curve.points;
      // The live "now" figure that replaces the last (at-cost, lagging) point:
      //  • networth → live net worth (idle + open TVL) = walletTotalSol.
      //  • pnl      → live real PnL = walletTotalSol − apportsLast (cumulative net deposits, last point).
      // Today (the last point) is reconstructed "at cost" and briefly LAGS the live tx stream: a fresh
      // deposit hits the cash ledger before its position shows up in the legs, so the line would dip.
      const apportsLast = pts.at(-1)?.apports ?? 0;
      const liveNow = source === 'networth' ? netWorth : netWorth - apportsLast;
      let prev: number | null = null;
      return pts.map((p, i) => {
        const base = source === 'networth' ? p.networth : p.realPnl;
        const value = i === pts.length - 1 && netWorth > 0 ? liveNow : base;
        const delta = prev == null ? 0 : value - prev;
        prev = value;
        return { t: Date.parse(`${p.date}T00:00:00Z`), realized: delta, cumulative: value };
      });
    }
    const positions = await api.profitHistory(scope, bucket, sinceMs(period, Date.now()));
    let run = 0;
    return positions.map((b) => {
      run += b.realized;
      return { t: b.t, realized: b.realized, cumulative: run };
    });
  }, [scope, bucket, closedVersion, period, source]);

  // Headline:
  //  • networth → the live net worth (idle cash + open positions' value) = walletTotalSol.
  //  • pnl      → the live real PnL = netWorth − apportsLast; that IS the last point's (forced) cumulative.
  //  • positions→ the cumulative line's end (the realized PnL over the window).
  // For pnl / positions the last forced cumulative already encodes the live "now" figure.
  const total =
    source === 'networth'
      ? netWorth
      : data && data.length > 0
        ? (data[data.length - 1]?.cumulative ?? null)
        : null;
  const svgRef = useRef<SVGSVGElement>(null);
  const [shareOpen, setShareOpen] = useState(false);

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-baseline gap-3">
              <CardTitle>{sourceTitle(source)}</CardTitle>
              {total != null && (
                <span className={cn('tabular font-semibold text-sm', toneText[toneOf(total)])}>
                  <SolAmount n={total} signed />
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {data && data.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShareOpen(true)}
                  aria-label="Share chart"
                  title="Share chart"
                  className="rounded-md bg-surface-2 p-1.5 text-muted transition-colors hover:bg-hover hover:text-text"
                >
                  <IconShare />
                </button>
              )}
              <Segmented<Source>
                value={source}
                onChange={setSource}
                options={[
                  { label: 'Net Worth', value: 'networth' },
                  { label: 'PnL', value: 'pnl' },
                  { label: 'Positions', value: 'positions' },
                ]}
              />
            </div>
          </div>
        </CardHeader>
        <div className="p-5">
          {error && !data ? (
            <EmptyState
              variant="error"
              title="Couldn't load PnL"
              hint="Check the connection."
              onRetry={refetch}
            />
          ) : loading && !data ? (
            <Skeleton className="h-[300px] w-full" />
          ) : !data || data.length === 0 ? (
            <EmptyState
              title={source === 'positions' ? 'No realized PnL yet' : 'No on-chain activity yet'}
              hint={
                source === 'positions'
                  ? 'Closed positions will chart here.'
                  : 'On-chain SOL cash-flow will chart here.'
              }
            />
          ) : (
            <div className={cn('transition-opacity', stale && 'opacity-60')} aria-busy={stale}>
              <ProfitGraph
                buckets={data}
                netWorth={netWorth}
                showBars={source === 'positions'}
                mode={source}
                svgRef={svgRef}
              />
              <p className="mt-3 text-[11px] text-faint leading-relaxed">{sourceNote(source)}</p>
            </div>
          )}
        </div>
      </Card>
      <ImageShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={sourceTitle(source)}
        filename={`binsight-${source}-pnl.png`}
        shareTitle={sourceTitle(source)}
        aspect="10 / 3"
        getImage={() => renderChartPng(svgRef.current)}
      />
    </>
  );
}

function ProfitGraph({
  buckets,
  netWorth,
  showBars = true,
  mode = 'positions',
  svgRef,
}: {
  buckets: ProfitBucket[];
  netWorth: number;
  showBars?: boolean;
  mode?: Source;
  svgRef?: React.Ref<SVGSVGElement>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const hideAmounts = usePrefs((s) => s.hideAmounts);

  const realized = buckets.map((b) => b.realized);
  const cum = buckets.map((b) => b.cumulative);
  // Y domain spans the line (always) and the bars (only when shown — the wallet view hides the bars,
  // whose daily values are capital churn that would otherwise blow up the scale).
  const forDomain = showBars ? [...cum, ...realized] : cum;
  const lo = Math.min(0, ...forDomain);
  const hi = Math.max(0, ...forDomain);
  const x = scale(0, Math.max(1, buckets.length - 1), PAD.left, W - PAD.right);
  const y = scale(lo, hi, H - PAD.bottom, PAD.top);
  const zeroY = y(0);
  const ticks = niceTicks(lo, hi, 4);

  const points: Point[] = buckets.map((_, i) => [x(i), y(cum[i]!)]);
  const barW = Math.max(2, (W - PAD.left - PAD.right) / buckets.length - 3);
  const last = buckets.length - 1;
  const active = hover != null ? buckets[hover] : null;
  const xLabelIdx = [
    // De-dup: at length 3 the rounded ⅓/⅔ ticks both land on index 1 ([0,1,1,2]) — collapse so each
    // index (and thus each React key) is unique and no label is rendered twice.
    ...new Set(
      last < 1
        ? [0]
        : last === 1
          ? [0, 1]
          : [0, Math.round(last / 3), Math.round((2 * last) / 3), last],
    ),
  ];

  const pickAt = (clientX: number, rect: DOMRect) => {
    // Invert x(): map the cursor back to a bucket index, accounting for the axis padding.
    const unit = ((clientX - rect.left) / rect.width) * W;
    const i = Math.round(((unit - PAD.left) / (W - PAD.left - PAD.right)) * last);
    setHover(Math.min(last, Math.max(0, i)));
  };
  // Tooltip x: anchor left near the left edge, right near the right edge, centred otherwise — so the
  // panel never clips the card.
  const hoverX = hover != null ? (x(hover) / W) * 100 : 0;
  const tipLeft = Math.min(98, Math.max(2, hoverX));
  const tipTx = hoverX < 24 ? '0%' : hoverX > 76 ? '-100%' : '-50%';
  const cumHover = hover != null ? cum[hover]! : 0;
  // Profit / cumulative as a percentage of the current net worth (LPAgent-style). Null if unknown.
  const nwPct = (v: number) => (netWorth > 0 ? `${((v / netWorth) * 100).toFixed(2)}%` : null);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-80">
        {/* Y-axis labels (HTML overlay — SVG text distorts under preserveAspectRatio=none) */}
        {ticks.map((t) => (
          <div
            key={t}
            className="-translate-y-1/2 absolute left-0 w-10 pr-2 text-right text-[10px] text-faint tabular"
            style={{ top: `${(y(t) / H) * 100}%` }}
          >
            {hideAmounts ? '' : fmtTick(t)}
          </div>
        ))}

        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          role="img"
          aria-label="Cumulative realized PnL over time"
        >
          {/* horizontal gridlines + zero baseline */}
          {ticks.map((t) => (
            <line
              key={t}
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke={t === 0 ? 'var(--color-border-strong)' : 'var(--color-border)'}
              strokeDasharray={t === 0 ? undefined : '2 5'}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/* per-period realized bars (same axis as the line) — hidden for the wallet view */}
          {showBars &&
            buckets.map((b, i) => {
              const yr = y(b.realized);
              const up = b.realized >= 0;
              return (
                <rect
                  key={b.t}
                  x={x(i) - barW / 2}
                  y={up ? yr : zeroY}
                  width={barW}
                  height={Math.max(0.5, Math.abs(yr - zeroY))}
                  rx="1"
                  fill={up ? 'var(--color-profit)' : 'var(--color-loss)'}
                  opacity={hover === i ? 0.95 : 0.5}
                />
              );
            })}

          {/* the accent line is the hero — no heavy area fill (kept clean, LPAgent-style) */}
          <path
            d={linePath(points)}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {hover != null && (
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--color-border-strong)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* biome-ignore lint/a11y/noStaticElementInteractions: chart-hover crosshair; the same data is in the History table. */}
          <rect
            x="0"
            y="0"
            width={W}
            height={H}
            fill="transparent"
            onMouseMove={(e) => pickAt(e.clientX, e.currentTarget.getBoundingClientRect())}
            onMouseLeave={() => setHover(null)}
            onTouchMove={(e) => {
              const t = e.touches[0];
              if (t) pickAt(t.clientX, e.currentTarget.getBoundingClientRect());
            }}
            onTouchEnd={() => setHover(null)}
          />
        </svg>

        {active && hover != null && (
          // HTML scrubber dot (an SVG circle would distort under preserveAspectRatio=none).
          <div
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-bg"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              top: `${(y(cumHover) / H) * 100}%`,
            }}
          />
        )}

        {active && hover != null && (
          // Absolute wrapper so the Tooltip (its base is position:relative, for its lit edge) is
          // placed correctly; clamp + translateX flip keeps it inside the card.
          <div
            className="pointer-events-none absolute top-3 z-10"
            style={{ left: `${tipLeft}%`, transform: `translateX(${tipTx})` }}
          >
            <Tooltip
              className="min-w-40 whitespace-nowrap"
              style={{
                background: 'var(--color-surface-2)',
                borderColor: 'var(--color-border-strong)',
              }}
            >
              <div className="mb-1.5 text-[11px] text-faint">{fmtDate(active.t)}</div>
              {mode !== 'positions' ? (
                <>
                  <TipRow
                    label={mode === 'networth' ? 'Net Worth' : 'Real PnL'}
                    value={hideAmounts ? AMOUNT_MASK : fmtSolSigned(cumHover)}
                    tone={mode === 'networth' ? 'neutral' : toneOf(cumHover)}
                  />
                  <TipRow
                    label="Day's change"
                    value={hideAmounts ? AMOUNT_MASK : fmtSolSigned(active.realized)}
                    tone={toneOf(active.realized)}
                  />
                </>
              ) : (
                <>
                  {showBars && (
                    <TipRow
                      label="This period"
                      value={hideAmounts ? AMOUNT_MASK : fmtSolSigned(active.realized)}
                      tone={toneOf(active.realized)}
                    />
                  )}
                  <TipRow
                    label="Cumulative"
                    value={hideAmounts ? AMOUNT_MASK : fmtSolSigned(cumHover)}
                    tone={toneOf(cumHover)}
                  />
                  {nwPct(cumHover) && (
                    <TipRow
                      label="vs Net Worth"
                      value={hideAmounts ? AMOUNT_MASK : nwPct(cumHover)!}
                      tone={toneOf(cumHover)}
                    />
                  )}
                </>
              )}
            </Tooltip>
          </div>
        )}
      </div>

      {/* X-axis date labels — evenly spaced; flex matches the linear data positions (0 / ⅓ / ⅔ / 1). */}
      <div
        className="flex justify-between text-[10px] text-faint tabular"
        style={{
          paddingLeft: `${(PAD.left / W) * 100}%`,
          paddingRight: `${(PAD.right / W) * 100}%`,
        }}
      >
        {xLabelIdx.map((i) => (
          <span key={buckets[i]!.t}>{fmtDate(buckets[i]!.t)}</span>
        ))}
      </div>
    </div>
  );
}

/** A right-aligned label/value row in the chart tooltip (value tinted by P&L tone). */
function TipRow({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-6 text-xs tabular">
      <span className="text-muted">{label}</span>
      <span className={cn('font-medium', toneText[tone])}>{value}</span>
    </div>
  );
}

/** Export the chart SVG as a PNG: resolve the CSS-var colours to concrete values, lay it on an opaque
 *  surface, rasterise at 2×. Axis labels are HTML overlays (omitted) — the curve shape is the artifact,
 *  and amounts are hidden anyway when sharing the curve. */
/** Rasterise the chart SVG to a PNG Blob: resolve the CSS-var colours, lay it on an opaque surface at
 *  2×, then stamp the Binsight watermark bottom-left. Returns a Blob so the share dialog can preview /
 *  copy / download it (instead of forcing an immediate download). */
function renderChartPng(svg: SVGSVGElement | null): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!svg) {
      reject(new Error('chart not ready'));
      return;
    }
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
    let inner = new XMLSerializer().serializeToString(svg);
    // border-strong BEFORE border (substring), so the plain-border pass doesn't touch it.
    const subs: [string, string][] = [
      ['var(--color-accent)', v('--color-accent', '#22d3ee')],
      ['var(--color-border-strong)', v('--color-border-strong', '#3a3f4b')],
      ['var(--color-border)', v('--color-border', '#2a2e38')],
      ['var(--color-profit)', v('--color-profit', '#34d399')],
      ['var(--color-loss)', v('--color-loss', '#fb7185')],
    ];
    for (const [from, to] of subs) inner = inner.replaceAll(from, to);
    const body = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    const svgStr =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
      `<rect width="100%" height="100%" fill="${v('--color-surface', '#1e2129')}"/>${body}</svg>`;
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const c = document.createElement('canvas');
      c.width = W * scale;
      c.height = H * scale;
      const ctx = c.getContext('2d');
      if (!ctx) {
        reject(new Error('no 2d context'));
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      drawWatermark(ctx, v('--color-accent', '#22d3ee'));
      c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('chart image failed to load'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgStr)}`;
  });
}

/** The Binsight mark (concentrated-liquidity bins, active bin brightest), bottom-left. */
function drawWatermark(ctx: CanvasRenderingContext2D, accent: string) {
  const ox = 18;
  const baseY = H - 16;
  const s = 0.07;
  const bars: [number, number][] = [
    [68, 135],
    [148, 216],
    [228, 300],
    [308, 216],
    [388, 135],
  ];
  const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.save();
  ctx.fillStyle = accent;
  bars.forEach(([bx, bh], i) => {
    const h = bh * s;
    ctx.globalAlpha = i === 2 ? 0.95 : 0.55;
    roundRect(ox + (bx - 68) * s, baseY - h, 56 * s, h, 28 * s);
    ctx.fill();
  });
  ctx.restore();
}

'use client';

import type { ClosedPosition, StrategyFamily } from '@meteora/shared';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useState } from 'react';
import type { Tone } from '@/domain/position';
import { useMoney } from '@/presentation/hooks/use-money';
import { Badge, cn, IconChartToggle, Skeleton, toneText } from '@/presentation/ui';
import { PositionChart, type PositionChartInput } from './position-chart';
import { ShareCardButton } from './share-card-button';

/** Token logo URLs from the datapi are often slow/flaky sources (ipfs.io gateways, the archived
 *  solana-labs token-list on raw.githubusercontent). Route them through the wsrv.nl image proxy,
 *  which caches + resizes + re-encodes to webp, so they load fast and reliably (or fall back to the
 *  letter chip via onError). */
function iconUrl(src: string): string {
  return `https://wsrv.nl/?url=${encodeURIComponent(src)}&w=44&h=44&fit=cover&output=webp`;
}

function TokenIcon({ src, symbol }: { src?: string; symbol: string }) {
  const [err, setErr] = useState(false);
  if (src && !err) {
    return (
      // biome-ignore lint/performance/noImgElement: token icons load from arbitrary external CDNs (per token mint); next/image would need per-host remotePatterns config that isn't feasible for user-supplied tokens.
      <img
        src={iconUrl(src)}
        alt=""
        width={20}
        height={20}
        loading="lazy"
        onError={() => setErr(true)}
        className="size-5 rounded-full bg-surface-2 object-cover ring-2 ring-surface"
      />
    );
  }
  return (
    <span className="grid size-5 place-items-center rounded-full bg-surface-2 font-semibold text-[9px] text-muted ring-2 ring-surface">
      {symbol.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function TokenPair({
  pair,
  iconX,
  iconY,
  strategy,
  actions,
}: {
  pair: string;
  iconX?: string;
  iconY?: string;
  strategy: StrategyFamily | null;
  /** Hover-revealed open-on-Meteora / GMGN links, sitting immediately right of the pair. */
  actions?: ReactNode;
}) {
  const [x = '', y = ''] = pair.split('/');
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="-space-x-1.5 flex shrink-0 items-center">
        <TokenIcon src={iconX} symbol={x} />
        <TokenIcon src={iconY} symbol={y} />
      </div>
      <span className="truncate font-medium text-sm text-text">{pair}</span>
      {strategy && <Badge>{strategy}</Badge>}
      {actions}
    </div>
  );
}

/** A PnL value with its percentage stacked beneath, LPAgent-style. */
export function PnlCell({ sol, pct, tone }: { sol: number; pct: number; tone: Tone }) {
  const m = useMoney();
  return (
    <div className={cn('tabular text-sm leading-tight', toneText[tone])}>
      <div className="inline-flex items-center gap-1">{m.sol(sol, { signed: true })}</div>
      <div className="text-xs">{m.pct(pct)}</div>
    </div>
  );
}

const stop = (e: MouseEvent) => e.stopPropagation();

/** A hover-revealed external link badged with the destination site's real favicon. */
function FaviconLink({ href, src, label }: { href: string; src: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={stop}
      title={label}
      aria-label={label}
      className="rounded-md p-1.5 opacity-80 transition-all hover:bg-surface-2 hover:opacity-100"
    >
      {/* biome-ignore lint/performance/noImgElement: a tiny bundled brand favicon — next/image is unnecessary for a fixed 16px static asset. */}
      <img src={src} alt="" width={16} height={16} className="size-4 rounded-[3px]" />
    </a>
  );
}

/** Hover-revealed pool links (Meteora pool + GMGN token), badged with each site's real logo. Lives
 *  right of the token pair; uses opacity (not display) so the row never reflows on hover. Anchors
 *  stop propagation so a click opens the link, not the drawer. When `shareClosed` is set (closed
 *  positions), a discreet share-card button is appended. */
export function PoolActions({
  poolAddress,
  tokenMint,
  shareClosed,
}: {
  poolAddress: string;
  tokenMint: string;
  shareClosed?: ClosedPosition;
}) {
  return (
    <div className="-my-1 ml-0.5 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-[var(--dur-fast)] focus-within:opacity-100 group-hover:opacity-100">
      <FaviconLink
        href={`https://app.meteora.ag/dlmm/${poolAddress}`}
        src="/meteora.png"
        label="Open pool on Meteora"
      />
      <FaviconLink
        href={`https://gmgn.ai/sol/token/${tokenMint}`}
        src="/gmgn.png"
        label="Open token on GMGN"
      />
      {shareClosed && <ShareCardButton position={shareClosed} />}
    </div>
  );
}

/** Header row aligned with RowShell (chart-toggle spacer + the shared column grid). */
export function RowHeader({ gridCols, children }: { gridCols: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1 border-border border-b px-2 py-2 font-medium text-[11px] text-faint uppercase tracking-wide">
      <span className="w-7 shrink-0" />
      <div
        className="grid min-w-[640px] flex-1 gap-3 pr-2"
        style={{ gridTemplateColumns: gridCols }}
      >
        {children}
      </div>
    </div>
  );
}

/** Loading placeholder matching RowShell's geometry (chart-toggle spacer + the shared column grid),
 *  so rows don't reflow when real data lands. */
export function RowSkeleton({ gridCols, rows = 4 }: { gridCols: string; rows?: number }) {
  const cellKeys = gridCols
    .trim()
    .split(/\s+/)
    .map((col, i) => `${col}-${i}`);
  const rowKeys = Array.from({ length: rows }, (_, i) => `row-${i}`);
  return (
    <div className="divide-y divide-border">
      {rowKeys.map((rowKey) => (
        <div key={rowKey} className="flex items-center gap-1 px-2">
          <span className="w-7 shrink-0" />
          <div
            className="grid min-w-[640px] flex-1 items-center gap-3 py-3 pr-2"
            style={{ gridTemplateColumns: gridCols }}
          >
            {cellKeys.map((cellKey, c) => (
              <Skeleton
                key={cellKey}
                className={cn('h-4', c === cellKeys.length - 1 ? 'ml-auto w-14' : 'w-20')}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A position row: a chart toggle (expands an embedded price chart) on the far left, then the
 *  clickable column grid that opens the detail drawer. The hover-revealed Meteora / GMGN links sit
 *  inside the first column (right of the token pair) — see TokenPair's `actions` prop. The grid is a
 *  role="button" div (not a <button>) so those anchor links can be validly nested inside it. */
export function RowShell({
  gridCols,
  cols,
  onOpen,
  chart,
  chartOpen,
  onToggleChart,
}: {
  gridCols: string;
  cols: ReactNode;
  onOpen: () => void;
  chart: PositionChartInput;
  /** Controlled by the parent table so only one row's chart is expanded at a time. */
  chartOpen: boolean;
  onToggleChart: () => void;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only act when the row itself is focused — not when a nested link (Meteora/GMGN) is, so
    // Enter/Space on a focused link activates the link instead of opening the drawer.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <div className="group flex flex-col">
      <div className="flex items-center gap-1 px-2 transition-colors hover:bg-hover active:bg-surface-2">
        <button
          type="button"
          onClick={onToggleChart}
          title="Toggle price chart"
          aria-label="Toggle price chart"
          aria-expanded={chartOpen}
          className={cn(
            'shrink-0 cursor-pointer rounded-md p-1.5 transition-colors hover:bg-surface-2',
            chartOpen ? 'text-accent' : 'text-faint hover:text-text',
          )}
        >
          <IconChartToggle />
        </button>
        {/* biome-ignore lint/a11y/useSemanticElements: must be a div (not <button>) so the Meteora/GMGN anchor links rendered inside the first column can be validly nested — anchors cannot nest inside a <button>. Full button semantics are preserved via role + tabIndex + Enter/Space handling. */}
        <div
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={onKey}
          className="grid flex-1 cursor-pointer items-center gap-3 py-3 pr-2 text-left"
          style={{ gridTemplateColumns: gridCols }}
        >
          {cols}
        </div>
      </div>
      {chartOpen && <PositionChart {...chart} />}
    </div>
  );
}

'use client';

import type { ClosedPosition } from '@binsight/shared';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { type SelectedPosition, useUi } from '@/application/stores/ui-store';
import { fmtAmount, fmtDate, fmtDuration, rangeLabel, shortAddr } from '@/domain/format';
import { type OpenPositionEntity, toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useCopy } from '@/presentation/hooks/use-copy';
import { useMoney } from '@/presentation/hooks/use-money';
import { useScopedQuery } from '@/presentation/hooks/use-scoped-query';
import {
  Badge,
  cn,
  Drawer,
  EmptyState,
  IconCheck,
  IconCopy,
  IconExternal,
  Skeleton,
  SolAmount,
  Stat,
  toneText,
} from '@/presentation/ui';
import { BinHistogram } from './bin-histogram';
import { HistoryTimeline } from './history-timeline';
import { ShareCardButton } from './share-card-button';

const YEAR_SECONDS = 31_536_000;

/** Annualised fee yield (%) = fees/base scaled to a year. Null when not computable (no base/duration). */
function feeApr(fees: number, base: number, seconds: number): number | null {
  if (base <= 0 || seconds <= 0) return null;
  return (fees / base) * (YEAR_SECONDS / seconds) * 100;
}

const fmtApr = (apr: number | null): string =>
  apr == null
    ? '—'
    : `${apr.toLocaleString('en-US', { maximumFractionDigits: apr >= 100 ? 0 : 1 })}%`;

export function PositionDrawer() {
  const selected = useUi((s) => s.selected);
  const select = useUi((s) => s.select);

  return (
    <Drawer
      open={selected != null}
      onClose={() => select(null)}
      title={selected && <DrawerTitle selected={selected} />}
    >
      {selected && <DrawerBody key={selected.address} selected={selected} />}
    </Drawer>
  );
}

function DrawerTitle({ selected }: { selected: SelectedPosition & object }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-medium text-sm text-text">{selected.pair}</span>
      <a
        href={`https://solscan.io/account/${selected.address}`}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-faint text-xs transition-colors hover:text-muted"
      >
        {shortAddr(selected.address)}
        <IconExternal />
      </a>
      <CopyButton text={selected.address} />
      {/* Closed positions can be exported as the PnL share-card PNG. */}
      {selected.closed && <ShareCardButton position={selected.closed} className="-my-1" />}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      aria-label="Copy address"
      title="Copy address"
      onClick={() => copy(text)}
      className="rounded p-0.5 text-faint transition-colors hover:text-text"
    >
      {copied ? <IconCheck /> : <IconCopy />}
    </button>
  );
}

function DrawerBody({ selected }: { selected: SelectedPosition & object }) {
  const [symbolX = '', symbolY = ''] = selected.pair.split('/');
  const entity = usePortfolio((s) =>
    selected.open ? (s.portfolio?.open.find((p) => p.address === selected.address) ?? null) : null,
  );
  // Only open positions have live on-chain liquidity — skip the bins fetch (404) for closed ones.
  const bins = useScopedQuery(
    () => (selected.open ? api.bins(selected.address) : Promise.resolve(null)),
    [selected.address, selected.open],
  );
  const history = useScopedQuery(() => api.history(selected.address), [selected.address]);

  const poolAddress = entity?.raw.poolAddress ?? selected.closed?.poolAddress;
  const tokenMint = entity?.raw.tokenXMint ?? selected.closed?.tokenXMint;

  return (
    <div className="flex flex-col gap-7 p-5">
      {entity && <OpenSummary p={entity} />}
      {selected.closed && <ClosedSummary p={selected.closed} />}

      <QuickLinks poolAddress={poolAddress} tokenMint={tokenMint} tokenSymbol={symbolX} />

      {selected.open && (
        <section>
          <SectionTitle>Liquidity by price</SectionTitle>
          {bins.loading ? (
            <Skeleton className="h-36 w-full" />
          ) : bins.data ? (
            <BinHistogram data={bins.data} />
          ) : bins.error ? (
            <EmptyState variant="error" title="Couldn't load liquidity" onRetry={bins.refetch} />
          ) : (
            <EmptyState title="No live liquidity" />
          )}
        </section>
      )}

      <section>
        <SectionTitle>History</SectionTitle>
        {history.loading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-full" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-5 w-2/3" />
          </div>
        ) : history.data && history.data.events.length > 0 ? (
          <HistoryTimeline events={history.data.events} symbolX={symbolX} symbolY={symbolY} />
        ) : history.error ? (
          <EmptyState variant="error" title="Couldn't load history" onRetry={history.refetch} />
        ) : (
          <EmptyState title="No on-chain history" />
        )}
      </section>
    </div>
  );
}

function OpenSummary({ p }: { p: OpenPositionEntity }) {
  const m = useMoney();
  const walletTotal = usePortfolio(
    (s) => s.portfolio?.open.reduce((sum, o) => sum + o.sizeSol, 0) ?? 0,
  );
  const heldSeconds = p.raw.openedAt ? (Date.now() - p.raw.openedAt) / 1000 : 0;
  const apr = feeApr(p.totalFeesSol, p.sizeSol, heldSeconds);
  const share = walletTotal > 0 ? (p.sizeSol / walletTotal) * 100 : null;
  const openedFor = p.raw.openedAt ? fmtDuration(heldSeconds) : '—';

  return (
    <section>
      <SectionTitle>Position</SectionTitle>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Stat label="Value" value={<SolAmount n={p.sizeSol} />} />
        <Stat
          label="Unrealized PnL"
          tone={p.tone}
          value={<SolAmount n={p.pnlSol} signed />}
          sub={m.pct(p.pnlPct)}
        />
        <Stat label="Fee APR" value={fmtApr(apr)} sub={`${p.feeYieldPct.toFixed(2)}% earned`} />
        <Stat label="Share of wallet" value={share == null ? '—' : `${share.toFixed(1)}%`} />
        <Stat label="Claimed fees" value={<SolAmount n={p.raw.claimedFeesSol} />} />
        <Stat
          label="Unclaimed fees"
          tone={p.raw.unclaimedFeesSol > 0 ? 'profit' : 'neutral'}
          value={<SolAmount n={p.raw.unclaimedFeesSol} />}
        />
        <Stat label="Open for" value={openedFor} />
        <Stat
          label="Range"
          value={<Badge tone={p.inRange ? 'in' : 'out'}>{rangeLabel(p.rangeStatus)}</Badge>}
        />
      </div>
    </section>
  );
}

function ClosedSummary({ p }: { p: ClosedPosition }) {
  const m = useMoney();
  const apr = feeApr(p.feesSol, p.depositSol, p.durationSeconds ?? 0);
  const hasResidual = (p.residualAmount ?? 0) > 0 && !!p.residualMint;

  return (
    <section>
      <SectionTitle>Summary</SectionTitle>
      <div className="grid grid-cols-2 gap-x-6 gap-y-4">
        <Stat
          label="Realized PnL"
          tone={toneOf(p.pnlSol)}
          value={<SolAmount n={p.pnlSol} signed />}
          sub={m.pct(p.pnlPctSol)}
        />
        <Stat label="Fee earned" value={<SolAmount n={p.feesSol} />} sub={`${fmtApr(apr)} APR`} />
        <Stat label="Invested" value={<SolAmount n={p.depositSol} />} />
        <Stat label="Withdrawn" value={<SolAmount n={p.withdrawSol} />} />
        <Stat label="Opened" value={fmtDate(p.openedAt)} />
        <Stat label="Closed" value={fmtDate(p.closedAt)} sub={fmtDuration(p.durationSeconds)} />
      </div>

      <div className="mt-5">
        <SubLabel>Breakdown</SubLabel>
        <div className="mt-2 flex flex-col gap-1.5 text-sm">
          <BreakdownRow label="Invested" value={-p.depositSol} />
          <BreakdownRow label="Withdrawn" value={p.withdrawSol} />
          <BreakdownRow label="Fees" value={p.feesSol} />
          {hasResidual && (
            <BreakdownRow label="Residual (sold/marked)" value={p.residualMarkSol ?? 0} />
          )}
          <div className="mt-1 border-border border-t pt-1.5">
            <BreakdownRow label="Net PnL" value={p.pnlSol} strong />
          </div>
        </div>
      </div>

      {hasResidual && (
        <p className="mt-3 text-faint text-xs">
          Residual {fmtAmount(p.residualAmount ?? 0)} {p.tokenX} left at close, marked at{' '}
          <SolAmount n={p.residualMarkSol ?? 0} /> (
          {p.pnlSource === 'market' ? 'live price' : 'pool spot'}).
        </p>
      )}
    </section>
  );
}

function BreakdownRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={strong ? 'font-medium text-text' : 'text-muted'}>{label}</span>
      <span className={cn(strong && 'font-medium', toneText[toneOf(value)])}>
        <SolAmount n={value} signed />
      </span>
    </div>
  );
}

function QuickLinks({
  poolAddress,
  tokenMint,
  tokenSymbol,
}: {
  poolAddress?: string;
  tokenMint?: string;
  tokenSymbol?: string;
}) {
  const links: { label: string; href: string }[] = [];
  if (poolAddress)
    links.push({ label: 'Meteora pool', href: `https://app.meteora.ag/dlmm/${poolAddress}` });
  if (tokenMint) {
    links.push({
      label: `${tokenSymbol || 'Token'} · Solscan`,
      href: `https://solscan.io/token/${tokenMint}`,
    });
    links.push({
      label: `${tokenSymbol || 'Token'} · GMGN`,
      href: `https://gmgn.ai/sol/token/${tokenMint}`,
    });
  }
  if (links.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {links.map((l) => (
        <a
          key={l.href}
          href={l.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-muted text-xs transition-colors hover:bg-hover hover:text-text"
        >
          {l.label}
          <IconExternal />
        </a>
      ))}
    </div>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <h3 className="mb-3 font-medium text-faint text-xs uppercase tracking-wide">{children}</h3>
  );
}

function SubLabel({ children }: { children: string }) {
  return <span className="font-medium text-faint text-xs uppercase tracking-wide">{children}</span>;
}

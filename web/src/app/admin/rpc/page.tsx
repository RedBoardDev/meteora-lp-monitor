'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { fmtAmount, fmtDate, shortAddr } from '@/domain/format';
import {
  aggregateDailyCredits,
  type CreditWeight,
  maxCredits,
  methodWeight,
  type RpcAnomaly,
  type RpcCreditLedgerRow,
  type RpcRingEntry,
  type RpcTelemetry,
  severityTone,
  sortedByCredits,
  todayTotals,
} from '@/domain/rpc-telemetry';
import { api } from '@/infrastructure/api/client';
import {
  Badge,
  Card,
  CardHeader,
  CardTitle,
  cn,
  EmptyState,
  Skeleton,
  Stat,
} from '@/presentation/ui';

/** Poll cadence for /debug/rpc — the meter's rolling window is 60s, so a few seconds keeps the live
 *  feed/kill-switch fresh without hammering the BFF. */
const POLL_MS = 5_000;

/** Bar fill colour by credit weight — banned (red) and heavy (amber) make a costly call pop instantly. */
const BAR_BG: Record<CreditWeight, string> = {
  banned: 'bg-loss',
  heavy: 'bg-warn',
  normal: 'bg-accent',
};

/** Breakdown-label text colour by weight (normal = muted, secondary to the bar). */
const LABEL_FG: Record<CreditWeight, string> = {
  banned: 'text-loss',
  heavy: 'text-warn',
  normal: 'text-muted',
};

/** Live-feed method text colour by weight (normal = full-strength text). */
const METHOD_FG: Record<CreditWeight, string> = {
  banned: 'text-loss',
  heavy: 'text-warn',
  normal: 'text-text',
};

export default function RpcCreditsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  // Same owner gate as /admin: the backend re-checks isOwner on every /debug/rpc call, this just keeps
  // a non-owner from seeing the shell.
  useEffect(() => {
    api
      .me()
      .then((me) => {
        setAllowed(me.isOwner);
        if (!me.isOwner) router.replace('/');
      })
      .catch(() => {
        setAllowed(false);
        router.replace('/login');
      });
  }, [router]);

  if (allowed !== true) {
    return <main className="grid min-h-dvh place-items-center text-muted text-sm">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-semibold text-lg text-text tracking-tight">RPC Credits</h1>
        <div className="flex items-center gap-4">
          <Link href="/admin" className="text-muted text-sm transition-colors hover:text-text">
            Admin
          </Link>
          <Link href="/" className="text-muted text-sm transition-colors hover:text-text">
            ← Dashboard
          </Link>
        </div>
      </div>
      <RpcPanel />
    </main>
  );
}

function RpcPanel() {
  const [data, setData] = useState<RpcTelemetry | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await api.debugRpc();
        if (!alive) return;
        setData(d);
        setError(false);
      } catch {
        if (alive) setError(true);
      } finally {
        if (alive) setLoading(false);
      }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  // Keep showing the last good snapshot if a single poll fails; only show the error state when we have
  // nothing at all (the very first poll failed).
  if (error && !data) {
    return (
      <Card>
        <EmptyState
          variant="error"
          title="Could not load RPC telemetry."
          hint="Retrying every few seconds."
        />
      </Card>
    );
  }
  if (!data) return null;

  const now = Date.now();
  const today = todayTotals(data.last7d, now);
  const hasRollup = (data.last7d?.length ?? 0) > 0;
  // "Today" comes from the durable rollup when present; otherwise fall back to the session ledger.
  const creditsToday = hasRollup ? today.credits : data.stats.totalCredits;
  const callsToday = hasRollup ? today.calls : data.stats.totalCalls;

  return (
    <div className="flex flex-col gap-4">
      {data.killSwitch.blockingNow && <KillSwitchBanner />}

      <Card className="p-5">
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
          <Stat
            label={hasRollup ? 'Credits today' : 'Credits (session)'}
            value={fmtAmount(creditsToday)}
          />
          <Stat
            label={hasRollup ? 'Calls today' : 'Calls (session)'}
            value={fmtAmount(callsToday)}
          />
          <Stat label="Session credits" value={fmtAmount(data.stats.totalCredits)} />
          <Stat
            label="Anomalies"
            value={data.anomalies.length}
            tone={data.anomalies.length > 0 ? 'loss' : 'neutral'}
          />
        </div>
      </Card>

      <AnomaliesCard anomalies={data.anomalies} />

      <BreakdownCard
        title="Credits by method"
        rec={data.stats.byMethod}
        weightOf={methodWeight}
        showLegend
      />
      <BreakdownCard title="Credits by code path" rec={data.stats.byCodePath} />
      <BreakdownCard title="Credits by wallet" rec={data.stats.byWallet} labelOf={shortAddr} />

      {hasRollup && <TrendCard rows={data.last7d ?? []} />}

      <LiveFeedCard entries={data.stats.ringTail} />
    </div>
  );
}

function KillSwitchBanner() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-loss/40 bg-loss/12 px-5 py-4">
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-loss" />
      <div>
        <p className="font-semibold text-loss text-sm">
          Kill-switch engaged — RPC calls are halting
        </p>
        <p className="text-muted text-xs">
          The rolling 60s credit rate breached the hard breaker; recurring calls are being skipped
          to protect the key budget.
        </p>
      </div>
    </div>
  );
}

function AnomaliesCard({ anomalies }: { anomalies: RpcAnomaly[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Anomalies</CardTitle>
        <span className="text-faint text-xs">{anomalies.length} active</span>
      </CardHeader>
      {anomalies.length === 0 ? (
        <p className="px-5 py-4 text-muted text-sm">
          No anomalies — credit usage is within budget.
        </p>
      ) : (
        <ul className="flex flex-col gap-2 p-5">
          {anomalies.map((a) => (
            <li key={`${a.kind}:${a.detail}`} className="flex items-center gap-3">
              <Badge tone={severityTone(a.severity)} className="shrink-0 capitalize">
                {a.severity}
              </Badge>
              <span className="font-medium text-sm text-text">{a.kind}</span>
              <span className="tabular truncate text-muted text-xs">{a.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BreakdownCard({
  title,
  rec,
  weightOf,
  labelOf,
  showLegend,
}: {
  title: string;
  rec: Record<string, number>;
  weightOf?: (key: string) => CreditWeight;
  labelOf?: (key: string) => string;
  showLegend?: boolean;
}) {
  const entries = sortedByCredits(rec);
  const max = maxCredits(entries);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {showLegend && (
          <div className="flex items-center gap-3 text-faint text-xs">
            <LegendDot className="bg-loss" label="banned (100cr)" />
            <LegendDot className="bg-warn" label="heavy (10cr)" />
          </div>
        )}
      </CardHeader>
      {entries.length === 0 ? (
        <p className="px-5 py-4 text-muted text-sm">No calls recorded this session.</p>
      ) : (
        <div className="flex flex-col gap-2.5 p-5">
          {entries.map((e) => (
            <CreditBar
              key={e.key}
              label={labelOf ? labelOf(e.key) : e.key}
              credits={e.credits}
              max={max}
              weight={weightOf ? weightOf(e.key) : 'normal'}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('size-2 rounded-full', className)} />
      {label}
    </span>
  );
}

function CreditBar({
  label,
  credits,
  max,
  weight,
}: {
  label: ReactNode;
  credits: number;
  max: number;
  weight: CreditWeight;
}) {
  // Floor the fill at 2% so a tiny-but-present value still draws a sliver (visible, not zero-width).
  const pct = max > 0 ? Math.max(2, (credits / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <div
        className={cn('w-36 shrink-0 truncate text-xs', LABEL_FG[weight])}
        title={typeof label === 'string' ? label : undefined}
      >
        {label}
      </div>
      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn('absolute inset-y-0 left-0 rounded-full', BAR_BG[weight])}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="tabular w-16 shrink-0 text-right text-text text-xs">{fmtAmount(credits)}</div>
    </div>
  );
}

function TrendCard({ rows }: { rows: RpcCreditLedgerRow[] }) {
  const daily = aggregateDailyCredits(rows);
  const max = daily.reduce((m, d) => Math.max(m, d.credits), 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Last 7 days</CardTitle>
        <span className="text-faint text-xs">credits / day</span>
      </CardHeader>
      <div className="flex items-end justify-between gap-2 px-5 pt-6 pb-3" style={{ height: 160 }}>
        {daily.map((d) => {
          const h = max > 0 ? Math.max(4, (d.credits / max) * 100) : 0;
          return (
            <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <span className="tabular text-faint text-xs">{fmtAmount(d.credits)}</span>
              <div className="flex w-full flex-1 items-end">
                <div
                  className="w-full rounded-t-sm bg-accent/70"
                  style={{ height: `${h}%` }}
                  title={`${d.calls} calls`}
                />
              </div>
              <span className="text-faint text-xs">{fmtDate(d.dayMs)}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function LiveFeedCard({ entries }: { entries: RpcRingEntry[] }) {
  // The ring tail is oldest→newest; show newest first.
  const rows = [...entries].reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Live feed</CardTitle>
        <span className="text-faint text-xs">{rows.length} recent calls</span>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-muted text-sm">No calls recorded yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-faint text-xs">
                <th className="px-4 py-2.5 text-left font-medium">Time</th>
                <th className="px-4 py-2.5 text-left font-medium">Method</th>
                <th className="px-4 py-2.5 text-left font-medium">Code path</th>
                <th className="px-4 py-2.5 text-left font-medium">Wallet</th>
                <th className="px-4 py-2.5 text-right font-medium">Credits</th>
                <th className="px-4 py-2.5 text-right font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <FeedRow key={`${e.at}:${i}`} entry={e} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ entry }: { entry: RpcRingEntry }) {
  if (entry.blocked) return <Badge tone="loss">blocked</Badge>;
  if (entry.ok) return <Badge tone="profit">ok</Badge>;
  return <Badge tone="warn">err</Badge>;
}

function FeedRow({ entry }: { entry: RpcRingEntry }) {
  const weight = methodWeight(entry.method);
  // A blocked (kill-switch-skipped) or banned-method call is the thing to spot — wash the whole row red.
  const flagged = entry.blocked || weight === 'banned';
  return (
    <tr className={cn('border-border/60 border-b last:border-0', flagged && 'bg-loss/8')}>
      <td className="tabular px-4 py-2 text-faint text-xs">
        {new Date(entry.at).toLocaleTimeString('en-US', { hour12: false })}
      </td>
      <td className={cn('px-4 py-2 font-medium', METHOD_FG[weight])}>{entry.method}</td>
      <td className="px-4 py-2 text-muted text-xs">{entry.codePath}</td>
      <td className="tabular px-4 py-2 text-muted text-xs">
        {entry.wallet ? shortAddr(entry.wallet) : '—'}
      </td>
      <td className="tabular px-4 py-2 text-right text-text">{entry.credits}</td>
      <td className="px-4 py-2 text-right">
        <StatusBadge entry={entry} />
      </td>
    </tr>
  );
}

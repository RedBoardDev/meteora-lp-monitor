'use client';

import type { Health, SourceStatus } from '@meteora/shared';
import { usePortfolio } from '@/application/stores/portfolio-store';
import { fmtRelative } from '@/domain/format';
import { StatusDot, Tooltip } from '@/presentation/ui';

function overall(health: Health | null, connected: boolean): SourceStatus {
  if (!health || !connected) return 'down';
  const statuses = health.sources.map((s) => s.status);
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('lagging') || !health.wsConnected) return 'lagging';
  return 'ok';
}

const LABEL: Record<SourceStatus, string> = { ok: 'Live', lagging: 'Degraded', down: 'Offline' };
const SOURCE_LABEL: Record<SourceStatus, string> = { ok: 'OK', lagging: 'Lagging', down: 'Down' };

export function HealthIndicator() {
  const health = usePortfolio((s) => s.health);
  const connected = usePortfolio((s) => s.connected);
  const status = overall(health, connected);

  // Hover-only: the detail panel reveals while the pointer is over the indicator (or the panel
  // itself, bridged by top-full + pt-1.5), and hides on leave. No click/pin.
  return (
    <div className="group relative">
      <div className="inline-flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted text-sm transition-colors group-hover:bg-hover group-hover:text-text">
        <StatusDot status={status} />
        <span>{LABEL[status]}</span>
      </div>
      {health && (
        <div
          id="health-popover"
          className="invisible absolute top-full right-0 z-30 w-64 translate-y-1 pt-1.5 opacity-0 transition duration-150 ease-spring group-hover:visible group-hover:translate-y-0 group-hover:opacity-100"
        >
          <SourcePopover health={health} />
        </div>
      )}
    </div>
  );
}

function SourcePopover({ health }: { health: Health }) {
  const now = Date.now();
  return (
    <Tooltip className="p-2">
      {health.sources.length === 0 && (
        <p className="px-2 py-1.5 text-faint text-xs">No source data yet.</p>
      )}
      {health.sources.map((src) => (
        <div
          key={src.name}
          className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5"
        >
          <div className="flex items-center gap-2">
            <StatusDot status={src.status} />
            <span className="font-medium text-sm text-text capitalize">{src.name}</span>
            <span className="text-faint text-xs">{SOURCE_LABEL[src.status]}</span>
          </div>
          <span className="text-faint text-xs">{src.detail ?? fmtRelative(src.lastOkAt, now)}</span>
        </div>
      ))}
      <div className="mt-1 border-border border-t px-2 pt-2 text-faint text-xs">
        {health.effectiveRps.toFixed(1)} rps · up {Math.floor(health.uptimeSeconds / 3600)}h
      </div>
    </Tooltip>
  );
}

'use client';

import type { ClosedPosition } from '@binsight/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fmtDuration } from '@/domain/format';
import { toneOf } from '@/domain/position';
import { api } from '@/infrastructure/api/client';
import { useMoney } from '@/presentation/hooks/use-money';
import {
  Badge,
  Button,
  cn,
  IconCheck,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconShare,
  Modal,
  toneText,
} from '@/presentation/ui';
import { COPIED_RESET_MS } from '@/presentation/ui/timing';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; blob: Blob }
  | { status: 'error' };

/** A clean share dialog for a closed position: a summary, the generated PnL card, and
 *  share / copy / download actions. The PNG is fetched once per open through the authenticated
 *  proxy and kept as a blob so it can be shared (Web Share), copied (Clipboard) or downloaded. */
export function ShareCardModal({
  position,
  open,
  onClose,
}: {
  position: ClosedPosition;
  open: boolean;
  onClose: () => void;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<string | null>(null);
  const m = useMoney();

  const pair = `${position.tokenX}/${position.tokenY}`;
  const tone = toneOf(position.pnlSol);
  const fileName = `pnl-${position.tokenX}-${position.tokenY}.png`.replace(/[^\w.-]+/g, '_');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ status: 'loading' });
      try {
        const blob = await api.positionCard(position.positionAddress, signal);
        if (signal?.aborted) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ status: 'ready', url, blob });
      } catch {
        if (!signal?.aborted) setState({ status: 'error' });
      }
    },
    [position.positionAddress],
  );

  // (Re)generate the card whenever the dialog opens; revoke the object URL on close.
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    load(ctrl.signal);
    setCopied(false);
    return () => {
      ctrl.abort();
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [open, load]);

  const blob = state.status === 'ready' ? state.blob : null;
  const url = state.status === 'ready' ? state.url : null;

  const shareFile = blob ? new File([blob], fileName, { type: 'image/png' }) : null;
  const canShare =
    !!shareFile &&
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [shareFile] });

  async function onShare() {
    if (!shareFile) return;
    try {
      await navigator.share({ files: [shareFile], title: `${pair} — PnL` });
    } catch {
      /* user cancelled or share failed — no-op */
    }
  }

  async function onCopy() {
    if (!blob) return;
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_RESET_MS);
    } catch {
      /* clipboard unavailable / denied */
    }
  }

  function onDownload() {
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
  }

  return (
    <Modal open={open} onClose={onClose} title={pair}>
      <div className="flex flex-col gap-4 p-5">
        {/* Summary */}
        <div className="flex items-start justify-between gap-3">
          <div className={cn('tabular leading-tight', toneText[tone])}>
            <div className="font-semibold text-2xl">{m.sol(position.pnlSol, { signed: true })}</div>
            <div className="text-sm opacity-75">{m.pct(position.pnlPctSol)}</div>
          </div>
          <div className="flex flex-col items-end gap-1 text-faint text-xs">
            {position.strategy && <Badge>{position.strategy}</Badge>}
            <span>
              Fees {m.sol(position.feesSol)} · Invested {m.sol(position.depositSol)}
            </span>
            <span>Held {fmtDuration(position.durationSeconds)}</span>
          </div>
        </div>

        {/* Card preview */}
        <div className="grid aspect-[3/2] place-items-center overflow-hidden rounded-lg border border-border bg-bg">
          {state.status === 'loading' && <IconRefresh className="size-5 animate-spin text-faint" />}
          {state.status === 'error' && (
            <div className="flex flex-col items-center gap-2 text-faint text-sm">
              <span>Couldn't generate the card.</span>
              <Button variant="subtle" onClick={() => load()}>
                Retry
              </Button>
            </div>
          )}
          {state.status === 'ready' && (
            // biome-ignore lint/performance/noImgElement: a generated blob URL, not a static asset — next/image can't optimise it.
            <img
              src={state.url}
              alt={`${pair} PnL card`}
              className="block h-full w-full object-cover"
            />
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2">
          {canShare && (
            <Button variant="subtle" onClick={onShare}>
              <IconShare /> Share
            </Button>
          )}
          <Button variant="subtle" onClick={onCopy} disabled={!blob}>
            {copied ? <IconCheck className="text-profit" /> : <IconCopy />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button variant="primary" onClick={onDownload} disabled={!url}>
            <IconDownload /> Download
          </Button>
        </div>
      </div>
    </Modal>
  );
}

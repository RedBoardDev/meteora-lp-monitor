'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  IconCheck,
  IconCopy,
  IconDownload,
  IconRefresh,
  IconShare,
  Modal,
} from '@/presentation/ui';
import { COPIED_RESET_MS } from '@/presentation/ui/timing';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; blob: Blob }
  | { status: 'error' };

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Download filename (also the Web-Share file name). */
  filename: string;
  /** Produces the PNG once per open — a server fetch or a client-side render. */
  getImage: (signal?: AbortSignal) => Promise<Blob>;
  /** Optional content above the preview (e.g. a position summary). */
  summary?: ReactNode;
  /** Preview box aspect ratio (CSS `aspect-ratio`), matched to the image — default 3 / 2. */
  aspect?: string;
  /** Title for the native share sheet (falls back to `title`). */
  shareTitle?: string;
};

/**
 * A reusable share dialog for a generated image: an optional summary, the image preview, and
 * share / copy / download actions. The PNG is produced once per open and kept as a blob so it can be
 * shared (Web Share), copied (Clipboard) or downloaded. Source-agnostic — used by the position PnL
 * card (server-rendered) and the PnL chart (client-rendered).
 */
export function ImageShareModal({
  open,
  onClose,
  title,
  filename,
  getImage,
  summary,
  aspect = '3 / 2',
  shareTitle,
}: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [copied, setCopied] = useState(false);
  const urlRef = useRef<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setState({ status: 'loading' });
      try {
        const blob = await getImage(signal);
        if (signal?.aborted) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        setState({ status: 'ready', url, blob });
      } catch {
        if (!signal?.aborted) setState({ status: 'error' });
      }
    },
    [getImage],
  );

  // (Re)generate whenever the dialog opens; revoke the object URL on close.
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

  const shareFile = blob ? new File([blob], filename, { type: 'image/png' }) : null;
  const canShare =
    !!shareFile &&
    typeof navigator !== 'undefined' &&
    typeof navigator.canShare === 'function' &&
    navigator.canShare({ files: [shareFile] });

  async function onShare() {
    if (!shareFile) return;
    try {
      await navigator.share({ files: [shareFile], title: shareTitle ?? title });
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
    a.download = filename;
    a.click();
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="flex flex-col gap-4 p-5">
        {summary}

        <div
          className="grid place-items-center overflow-hidden rounded-lg border border-border bg-bg"
          style={{ aspectRatio: aspect }}
        >
          {state.status === 'loading' && <IconRefresh className="size-5 animate-spin text-faint" />}
          {state.status === 'error' && (
            <div className="flex flex-col items-center gap-2 text-faint text-sm">
              <span>Couldn't generate the image.</span>
              <Button variant="subtle" onClick={() => load()}>
                Retry
              </Button>
            </div>
          )}
          {state.status === 'ready' && url && (
            // biome-ignore lint/performance/noImgElement: a generated blob URL, not a static asset — next/image can't optimise it.
            <img src={url} alt={title} className="block h-full w-full object-contain" />
          )}
        </div>

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

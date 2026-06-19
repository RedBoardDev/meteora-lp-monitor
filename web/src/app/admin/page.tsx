'use client';

import type { AccessEntry, WalletOverview } from '@binsight/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { shortAddr } from '@/domain/format';
import { api } from '@/infrastructure/api/client';
import { Button, Input, Modal } from '@/presentation/ui';

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type Tab = 'access' | 'wallets';

const day = (ms: number) => new Date(ms).toLocaleDateString();
function ago(ms: number | null): string {
  if (!ms) return 'never';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

type Confirm = { title: string; body: string; confirmLabel: string; onConfirm: () => void };

function ConfirmModal({ confirm, onClose }: { confirm: Confirm | null; onClose: () => void }) {
  return (
    <Modal open={confirm !== null} onClose={onClose} title={confirm?.title}>
      <div className="flex flex-col gap-5 p-5">
        <p className="text-muted text-sm leading-relaxed">{confirm?.body}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={() => {
              confirm?.onConfirm();
              onClose();
            }}
            className="rounded-lg bg-loss px-4 py-2 font-medium text-bg text-sm transition-opacity hover:opacity-90"
          >
            {confirm?.confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function AdminPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>('access');

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
    <main className="mx-auto max-w-4xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-semibold text-lg text-text tracking-tight">Admin</h1>
        <Link href="/" className="text-muted text-sm transition-colors hover:text-text">
          ← Dashboard
        </Link>
      </div>

      <div className="mb-6 inline-flex rounded-lg bg-surface-2/50 p-0.5 ring-1 ring-border ring-inset">
        {(['access', 'wallets'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm capitalize transition-colors ${
              tab === t ? 'bg-surface text-text' : 'text-muted hover:text-text'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'access' ? <AccessTab /> : <WalletsTab />}
    </main>
  );
}

function AccessTab() {
  const [rows, setRows] = useState<AccessEntry[]>([]);
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const load = useCallback(() => {
    api
      .access()
      .then(setRows)
      .catch(() => setError('Could not load access list.'));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const ok = await api.invite(address.trim(), note.trim());
    setBusy(false);
    if (ok) {
      setAddress('');
      setNote('');
      load();
    } else {
      setError('Could not invite — check the address.');
    }
  }

  function askRevoke(r: AccessEntry) {
    setConfirm({
      title: r.status === 'joined' ? 'Revoke account access' : 'Remove invite',
      body:
        r.status === 'joined'
          ? `Delete the account for ${shortAddr(r.address)} and remove its invite. They lose access immediately and can't re-register. Their watched wallets' data is kept (shared) — only live monitoring of wallets nobody else watches stops.`
          : `Remove the invite for ${shortAddr(r.address)}. This wallet won't be able to register.`,
      confirmLabel: r.status === 'joined' ? 'Revoke access' : 'Remove invite',
      onConfirm: async () => {
        if (await api.revoke(r.address)) load();
        else setError('Could not revoke.');
      },
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <form
        onSubmit={onInvite}
        className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-4 sm:flex-row"
      >
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Wallet address to invite"
          spellCheck={false}
          className="flex-1 px-3 py-2 font-mono text-sm"
        />
        <Input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          className="px-3 py-2 text-sm sm:w-40"
        />
        <Button type="submit" disabled={busy || !ADDRESS_RE.test(address.trim())}>
          Invite
        </Button>
      </form>
      {error && <p className="text-loss text-xs">{error}</p>}

      <ul className="flex flex-col gap-2">
        {rows.length === 0 && <li className="text-muted text-sm">No accounts or invites yet.</li>}
        {rows.map((r) => (
          <li
            key={r.address}
            className="flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3"
          >
            <div className="min-w-0">
              <p className="flex items-center gap-2 truncate font-mono text-sm text-text">
                {r.address}
                {r.isOwner && <span className="text-accent text-xs">owner</span>}
              </p>
              <p className="text-faint text-xs">
                <span className={r.status === 'joined' ? 'text-profit' : 'text-warn'}>
                  {r.status === 'joined' ? 'joined' : 'invited'}
                </span>
                {r.status === 'joined'
                  ? ` · ${r.wallets.length} wallet${r.wallets.length === 1 ? '' : 's'} · ${day(r.createdAt)}`
                  : r.note
                    ? ` · ${r.note}`
                    : ''}
              </p>
            </div>
            {r.isOwner ? (
              <span className="ml-3 shrink-0 text-faint text-xs">—</span>
            ) : (
              <button
                type="button"
                onClick={() => askRevoke(r)}
                className="ml-3 shrink-0 text-loss text-xs transition-opacity hover:opacity-80"
              >
                {r.status === 'joined' ? 'Revoke' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>

      <ConfirmModal confirm={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function WalletsTab() {
  const [rows, setRows] = useState<WalletOverview[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .adminWallets()
      .then(setRows)
      .catch(() => setError('Could not load wallets.'));
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-loss text-xs">{error}</p>}
      {rows.length === 0 && !error && (
        <p className="text-muted text-sm">No monitored wallets yet.</p>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-border border-b text-faint text-xs">
                <th className="px-4 py-2.5 text-left font-medium">Wallet</th>
                <th className="px-4 py-2.5 text-right font-medium">Watchers</th>
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Open</th>
                <th className="px-4 py-2.5 text-right font-medium">Closed</th>
                <th className="px-4 py-2.5 text-right font-medium">Last sync</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((w) => (
                <tr key={w.address} className="border-border/60 border-b last:border-0">
                  <td className="px-4 py-2.5 font-mono text-text">{shortAddr(w.address)}</td>
                  <td className="px-4 py-2.5 text-right text-muted">{w.watchers}</td>
                  <td className="px-4 py-2.5">
                    {w.ready === false ? (
                      <span className="text-warn text-xs">indexing… ({w.indexedTxs ?? 0} txs)</span>
                    ) : (
                      <span className="text-profit text-xs">ready</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-muted">{w.openPositions}</td>
                  <td className="px-4 py-2.5 text-right text-muted">{w.closedPositions}</td>
                  <td className="px-4 py-2.5 text-right text-faint">{ago(w.lastUpdate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

'use client';

import type { Wallet } from '@meteora/shared';
import { type FormEvent, useState } from 'react';
import { shortAddr } from '@/domain/format';
import { api } from '@/infrastructure/api/client';
import { useCopy } from '@/presentation/hooks/use-copy';
import { Badge, Button, IconCheck, IconCopy, Input } from '@/presentation/ui';

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Copy a wallet's full address with a brief check confirmation. */
function CopyAddr({ address }: { address: string }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      title="Copy address"
      aria-label="Copy address"
      onClick={() => copy(address)}
      className="grid size-7 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-hover hover:text-text"
    >
      {copied ? <IconCheck className="text-profit" /> : <IconCopy />}
    </button>
  );
}

type Props = { wallets: Wallet[]; onChanged: (removed?: string) => void };

export function WalletsEditor({ wallets, onChanged }: Props) {
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = address.trim();
  const valid = ADDRESS_RE.test(trimmed);
  const duplicate = wallets.some((w) => w.address === trimmed);

  async function onAdd(e: FormEvent) {
    e.preventDefault();
    if (!valid || duplicate) {
      setError(duplicate ? 'Already added.' : 'Not a valid Solana address.');
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await api.addWallet(trimmed, label.trim());
    setBusy(false);
    if (!ok) {
      setError('Could not add wallet.');
      return;
    }
    setAddress('');
    setLabel('');
    onChanged();
  }

  async function onRemove(addr: string) {
    if (await api.removeWallet(addr)) onChanged(addr);
  }

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1">
        {wallets.length === 0 && <li className="text-faint text-sm">No wallets yet.</li>}
        {wallets.map((w) => (
          <li
            key={w.address}
            className="flex items-center justify-between gap-3 rounded-md bg-surface-2 px-3 py-2"
          >
            <div className="flex min-w-0 flex-col">
              {w.label && <span className="truncate font-medium text-sm text-text">{w.label}</span>}
              <span className="tabular text-faint text-xs">{shortAddr(w.address, 6, 6)}</span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <CopyAddr address={w.address} />
              <button
                type="button"
                onClick={() => onRemove(w.address)}
                className="rounded-md px-2.5 py-1 font-medium text-faint text-xs transition-colors hover:bg-loss/12 hover:text-loss"
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>

      <form onSubmit={onAdd} className="flex flex-col gap-2 border-border border-t pt-4">
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="Wallet address"
          spellCheck={false}
          autoComplete="off"
          className="tabular"
        />
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
        />
        {error && (
          <p role="alert" className="text-loss text-xs">
            {error}
          </p>
        )}
        {trimmed.length > 0 && !valid && (
          <Badge tone="warn" className="self-start">
            invalid address
          </Badge>
        )}
        <Button type="submit" disabled={busy || !valid || duplicate} className="self-start">
          {busy ? 'Adding…' : 'Add wallet'}
        </Button>
      </form>
    </div>
  );
}

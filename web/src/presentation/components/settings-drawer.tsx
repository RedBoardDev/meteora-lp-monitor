'use client';

import type { Wallet } from '@meteora/shared';
import Link from 'next/link';
import { useEffect } from 'react';
import { useIdentity } from '@/application/stores/identity-store';
import { shortAddr } from '@/domain/format';
import { Drawer } from '@/presentation/ui';
import { PushToggle } from './push-toggle';
import { WalletsEditor } from './wallets-editor';

type Props = {
  open: boolean;
  onClose: () => void;
  wallets: Wallet[];
  onChanged: (removed?: string) => void;
};

export function SettingsDrawer({ open, onClose, wallets, onChanged }: Props) {
  const identity = useIdentity((s) => s.identity);
  const loadIdentity = useIdentity((s) => s.load);

  useEffect(() => {
    void loadIdentity();
  }, [loadIdentity]);

  return (
    <Drawer open={open} onClose={onClose} title="Wallets">
      <div className="flex flex-col gap-7 p-5">
        <section>
          <h3 className="mb-3 font-medium text-faint text-xs uppercase tracking-wide">Watchlist</h3>
          <WalletsEditor wallets={wallets} onChanged={onChanged} />
        </section>
        <PushToggle />
        {identity?.isOwner && (
          <section>
            <h3 className="mb-3 font-medium text-faint text-xs uppercase tracking-wide">Admin</h3>
            <Link
              href="/admin"
              onClick={onClose}
              className="flex items-center justify-between rounded-xl border border-border bg-base px-3.5 py-2.5 text-sm text-text transition-colors hover:border-text/30"
            >
              <span>Whitelist &amp; accounts</span>
              <span aria-hidden className="text-muted">
                →
              </span>
            </Link>
          </section>
        )}
        {identity && (
          <p className="text-center font-mono text-faint text-xs">
            Signed in as {shortAddr(identity.address)}
          </p>
        )}
      </div>
    </Drawer>
  );
}

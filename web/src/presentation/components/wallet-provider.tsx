'use client';

import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { WalletProvider } from '@solana/wallet-adapter-react';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import { type ReactNode, useMemo } from 'react';

/**
 * Wallet context for the auth flows ONLY — registration and password reset need the wallet to sign a
 * message (never a transaction, never RPC, so no ConnectionProvider). Scoped to the login subtree so
 * the heavy adapter code never loads on the dashboard. `autoConnect={false}` avoids any SSR/hydration
 * reconnection mismatch — the user explicitly picks a wallet.
 *
 * NOTE: the explicit Phantom + Solflare adapters are REQUIRED — relying on Wallet Standard
 * auto-detection alone surfaced no wallet in testing, so these stay (verified in Chrome).
 */
export function WalletProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <WalletProvider wallets={wallets} autoConnect={false}>
      {children}
    </WalletProvider>
  );
}

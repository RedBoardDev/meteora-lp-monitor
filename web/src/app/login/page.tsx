'use client';

import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet, type Wallet } from '@solana/wallet-adapter-react';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { useSession } from '@/application/stores/session-store';
import { shortAddr } from '@/domain/format';
import { authApi } from '@/infrastructure/api/client';
import { WalletProviders } from '@/presentation/components/wallet-provider';
import { Button, Input } from '@/presentation/ui';

const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
type Mode = 'signin' | 'signup' | 'reset';

/** Base64-encode raw signature bytes for transport to the backend (which base64-decodes + ed25519-verifies). */
function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export default function LoginPage() {
  return (
    <WalletProviders>
      <AuthCard />
    </WalletProviders>
  );
}

function AuthCard() {
  const router = useRouter();
  const login = useSession((s) => s.login);
  const setAuthed = useSession((s) => s.setAuthed);
  const { wallets, select, publicKey, connected, signMessage, disconnect } = useWallet();

  const [mode, setMode] = useState<Mode>('signin');
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notApproved, setNotApproved] = useState(false);
  const [busy, setBusy] = useState(false);

  const walletAddress = connected && publicKey ? publicKey.toBase58() : null;

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotApproved(false);
    setPassword('');
  }

  async function pickWallet(w: Wallet) {
    setError(null);
    setNotApproved(false);
    try {
      select(w.adapter.name);
      await w.adapter.connect();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect the wallet.');
    }
  }

  // Sign-in: address + password, no signature.
  async function onSignin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await login(address.trim(), password);
    setBusy(false);
    if (res.ok) router.replace('/');
    else setError(res.error ?? 'Invalid address or password.');
  }

  // Register / reset: prove ownership of the connected wallet, then set the password.
  async function onProve(e: FormEvent) {
    e.preventDefault();
    if (!walletAddress) return;
    if (!signMessage) {
      setError('This wallet cannot sign messages. Try Phantom or Solflare.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotApproved(false);
    try {
      const challenge = await authApi.nonce(
        walletAddress,
        mode === 'signup' ? 'register' : 'reset',
      );
      if (!challenge.ok) {
        if (challenge.notWhitelisted) setNotApproved(true);
        else setError(challenge.error ?? 'Could not start — please retry.');
        return;
      }
      const signature = toBase64(await signMessage(new TextEncoder().encode(challenge.message)));
      const submit = mode === 'signup' ? authApi.register : authApi.reset;
      const res = await submit({
        address: walletAddress,
        signature,
        nonce: challenge.nonce,
        password,
      });
      if (res.ok) {
        setAuthed(true);
        router.replace('/');
      } else {
        setError(res.error ?? 'Could not complete — please retry.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signature cancelled.');
    } finally {
      setBusy(false);
    }
  }

  const installable = wallets.filter(
    (w) =>
      w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable,
  );

  return (
    <main className="grid min-h-dvh place-items-center px-6">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-8 shadow-pop">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          {/* biome-ignore lint/performance/noImgElement: tiny static brand mark, no layout cost */}
          <img src="/icon.svg" alt="" width={56} height={56} className="size-14 rounded-2xl" />
          <div className="flex flex-col gap-1">
            <h1 className="font-semibold text-lg text-text tracking-tight">Binsight</h1>
            <p className="text-muted text-sm">
              {mode === 'signin' && 'Sign in to your portfolio.'}
              {mode === 'signup' && 'Connect your wallet to create an account.'}
              {mode === 'reset' && 'Reset your password with your wallet.'}
            </p>
          </div>
        </div>

        {mode === 'signin' ? (
          <form onSubmit={onSignin}>
            <label htmlFor="address" className="sr-only">
              Wallet address
            </label>
            <Input
              id="address"
              type="text"
              autoComplete="username"
              spellCheck={false}
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Wallet address"
              aria-invalid={error !== null}
              className="px-3.5 py-2.5 font-mono text-sm"
            />
            <label htmlFor="password" className="sr-only">
              Password
            </label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              aria-invalid={error !== null}
              className="mt-3 px-3.5 py-2.5"
            />
            {error && (
              <p role="alert" className="mt-2 text-loss text-xs">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={busy || !ADDRESS_RE.test(address.trim()) || password.length === 0}
              className="mt-5 w-full"
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
        ) : notApproved ? (
          <div className="flex flex-col gap-3 text-center">
            <p className="text-sm text-text">This wallet isn’t approved yet.</p>
            <p className="text-muted text-xs">
              The app is in private beta. Ask the owner to add{' '}
              <span className="font-mono">
                {walletAddress ? shortAddr(walletAddress) : 'your wallet'}
              </span>{' '}
              to the allowlist, then come back to create your account.
            </p>
          </div>
        ) : (
          <form onSubmit={onProve}>
            {!walletAddress ? (
              <div className="flex flex-col gap-2">
                {installable.length === 0 && (
                  <p className="text-muted text-xs">
                    No Solana wallet detected. Install Phantom or Solflare, then refresh.
                  </p>
                )}
                {installable.map((w) => (
                  <button
                    key={w.adapter.name}
                    type="button"
                    onClick={() => pickWallet(w)}
                    className="flex items-center gap-3 rounded-xl border border-border bg-base px-3.5 py-2.5 text-left text-sm text-text transition-colors hover:border-text/30"
                  >
                    {/* biome-ignore lint/performance/noImgElement: wallet icon from the adapter */}
                    <img src={w.adapter.icon} alt="" width={22} height={22} className="size-5" />
                    Connect {w.adapter.name}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between rounded-xl border border-border bg-base px-3.5 py-2.5">
                  <span className="font-mono text-sm text-text">{shortAddr(walletAddress)}</span>
                  <button
                    type="button"
                    onClick={() => void disconnect()}
                    className="text-muted text-xs transition-colors hover:text-text"
                  >
                    Change
                  </button>
                </div>
                <label htmlFor="password" className="sr-only">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={mode === 'reset' ? 'New password (min 8)' : 'Password (min 8)'}
                  aria-invalid={error !== null}
                  className="px-3.5 py-2.5"
                />
                <Button
                  type="submit"
                  disabled={busy || password.length < 8}
                  className="mt-5 w-full"
                >
                  {busy
                    ? 'Verifying…'
                    : mode === 'reset'
                      ? 'Sign & set new password'
                      : 'Sign & create account'}
                </Button>
              </>
            )}
            {error && (
              <p role="alert" className="mt-2 text-loss text-xs">
                {error}
              </p>
            )}
          </form>
        )}

        <div className="mt-4 flex flex-col items-center gap-1.5 text-xs">
          {mode === 'signin' && (
            <>
              <button
                type="button"
                onClick={() => switchMode('signup')}
                className="text-muted transition-colors hover:text-text"
              >
                No account? Create one with your wallet
              </button>
              <button
                type="button"
                onClick={() => switchMode('reset')}
                className="text-muted transition-colors hover:text-text"
              >
                Forgot password?
              </button>
            </>
          )}
          {mode !== 'signin' && (
            <button
              type="button"
              onClick={() => switchMode('signin')}
              className="text-muted transition-colors hover:text-text"
            >
              ← Back to sign in
            </button>
          )}
        </div>
      </div>
    </main>
  );
}

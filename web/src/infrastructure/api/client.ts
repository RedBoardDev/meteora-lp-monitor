import type {
  AccessEntry,
  Bucket,
  Candle,
  ClosedPosition,
  NetworthCurve,
  PositionBins,
  PositionHistory,
  ProfitBucket,
  Stats,
  Wallet,
  WalletOverview,
  WalletPnlCurve,
  WalletState,
} from '@binsight/shared';

export type ClosedQuery = {
  q?: string;
  sort?: 'recent' | 'pnl' | 'fees' | 'duration';
  dir?: 'asc' | 'desc';
  result?: 'all' | 'win' | 'loss';
};

class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api/${path}`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new ApiError(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

async function send(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<boolean> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.ok;
}

async function getBlob(path: string, accept: string, signal?: AbortSignal): Promise<Blob> {
  const res = await fetch(`/api/${path}`, { headers: { accept }, signal });
  if (!res.ok) throw new ApiError(`GET ${path} failed (${res.status})`);
  return res.blob();
}

export type ClosedPage = { rows: ClosedPosition[]; total: number };

/** The caller's own identity, from `/auth/me`. */
export type AccountIdentity = { address: string; isOwner: boolean };

/** Typed client over the BFF proxy. The proxy attaches the session JWT server-side. */
export const api = {
  state: (scope: string) => get<WalletState>(`state?wallet=${encodeURIComponent(scope)}`),

  closed: (scope: string, page = 1, pageSize = 20, query: ClosedQuery = {}) => {
    const p = new URLSearchParams({
      wallet: scope,
      page: String(page),
      pageSize: String(pageSize),
    });
    if (query.q) p.set('q', query.q);
    if (query.sort) p.set('sort', query.sort);
    if (query.dir) p.set('dir', query.dir);
    if (query.result && query.result !== 'all') p.set('result', query.result);
    return get<ClosedPage>(`positions/closed?${p.toString()}`);
  },

  stats: (scope: string, since = 0) =>
    get<Stats>(`stats?wallet=${encodeURIComponent(scope)}${since > 0 ? `&since=${since}` : ''}`),

  profitHistory: (scope: string, bucket: Bucket, since = 0) =>
    get<ProfitBucket[]>(
      `stats/history?wallet=${encodeURIComponent(scope)}&bucket=${bucket}&since=${since}`,
    ),

  /** The TRUE wallet PnL curve from on-chain SOL cash-flow — captures rug/slippage losses the
   *  position-level history misses. `days` = window length. */
  walletPnlCurve: (scope: string, days: number) =>
    get<WalletPnlCurve>(`wallet/pnl-curve?wallet=${encodeURIComponent(scope)}&days=${days}`),

  /** The forward-only TRUE Net Worth curve (on-chain wallet total = tvl + idle, sampled over time). */
  networthCurve: (scope: string, days: number) =>
    get<NetworthCurve>(`networth/curve?wallet=${encodeURIComponent(scope)}&days=${days}`),

  /** SOL spot price in USD for the display-currency toggle (null when unavailable). */
  solUsd: () => get<{ price: number | null }>('sol-usd'),

  /** Web Push: fetch the VAPID public key, register/remove a browser subscription. */
  pushVapidKey: () => get<{ key: string }>('push/vapid-public-key'),
  pushSubscribe: (sub: unknown) => send('push/subscribe', 'POST', sub),
  pushUnsubscribe: (endpoint: string) => send('push/unsubscribe', 'POST', { endpoint }),
  pushTest: () => send('push/test', 'POST', {}),

  bins: (address: string) => get<PositionBins>(`positions/${address}/bins`),

  history: (address: string) => get<PositionHistory>(`positions/${address}/history`),

  /** The generated PnL share card (PNG) for a closed position, as a Blob. */
  positionCard: (address: string, signal?: AbortSignal) =>
    getBlob(`positions/${encodeURIComponent(address)}/card.png`, 'image/png', signal),

  /** OHLCV candles for a pool's price chart (SOL-priced). Empty `candles` ⇒ pool not indexed yet. */
  ohlcv: (pool: string, tf: string) =>
    get<{ candles: Candle[] }>(
      `pools/${encodeURIComponent(pool)}/ohlcv?tf=${encodeURIComponent(tf)}`,
    ),

  /** A single closed position by address — used to deep-link a position drawer from the URL. */
  position: (address: string) =>
    get<{ closed: ClosedPosition | null }>(`positions/${encodeURIComponent(address)}`),

  wallets: () => get<Wallet[]>('wallets'),

  addWallet: (address: string, label: string) => send('wallets', 'POST', { address, label }),

  removeWallet: (address: string) => send(`wallets/${encodeURIComponent(address)}`, 'DELETE'),

  refresh: () => send('refresh', 'POST'),

  /** The caller's own account (address + owner flag) — routed through the proxy. */
  me: () => get<AccountIdentity>('auth/me'),

  // ── Admin (owner only — the backend re-checks isOwner on every call) ──────────────────────────
  /** Unified access list: invited (whitelisted) + joined (registered) accounts. */
  access: () => get<AccessEntry[]>('admin/access'),
  /** Invite an address (whitelist it so it can register). */
  invite: (address: string, note: string) => send('admin/access', 'POST', { address, note }),
  /** Revoke access: delete the account (if any) AND remove the invite. */
  revoke: (address: string) => send(`admin/access/${encodeURIComponent(address)}`, 'DELETE'),
  /** Operational overview of every monitored wallet. */
  adminWallets: () => get<WalletOverview[]>('admin/wallets'),
};

/** Result of asking the backend for a signature challenge (register / reset step 1). */
export type NonceResult =
  | { ok: true; nonce: string; message: string }
  | { ok: false; status: number; error?: string; notWhitelisted?: boolean };

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Auth endpoints live outside the proxy (they manage the httpOnly cookie directly). Identity is the
 * Solana wallet address; the one-time signature is required only at register and password reset.
 */
export const authApi = {
  /** Register step 1 / reset step 1 — fetch the challenge to sign. */
  async nonce(address: string, kind: 'register' | 'reset'): Promise<NonceResult> {
    const res = await postJson(kind === 'register' ? '/api/auth/nonce' : '/api/auth/reset/nonce', {
      address,
    });
    const data = (await res.json().catch(() => ({}))) as {
      nonce?: string;
      message?: string;
      error?: string;
      notWhitelisted?: boolean;
    };
    if (res.ok && data.nonce && data.message) {
      return { ok: true, nonce: data.nonce, message: data.message };
    }
    return {
      ok: false,
      status: res.status,
      error: data.error,
      notWhitelisted: data.notWhitelisted,
    };
  },

  async login(address: string, password: string): Promise<{ ok: boolean; error?: string }> {
    const res = await postJson('/api/auth/login', { address, password });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error };
  },

  async register(p: {
    address: string;
    signature: string;
    nonce: string;
    password: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const res = await postJson('/api/auth/register', p);
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error };
  },

  async reset(p: {
    address: string;
    signature: string;
    nonce: string;
    password: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const res = await postJson('/api/auth/reset', p);
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error };
  },

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
  },

  async wsTicket(): Promise<string | null> {
    const res = await fetch('/api/auth/ws-ticket');
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string };
    return token;
  },
};

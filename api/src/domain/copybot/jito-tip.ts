/**
 * Copy-bot · Jito tip — PURE sizing + tip-account selection (no I/O). An anti-sandwich tip paid INSIDE the shared
 * priority-fee cap: `priorityFee + jitoTip ≤ maxCapSol`. The tip is a small conservative amount, bounded by whatever
 * headroom is left under the cap after the priority fee — so it never overspends and is starved (0) only when the
 * priority fee already used the whole cap. See docs/reference/copybot-settings.md §5.
 *
 * A Jito tip ONLY has effect when the tx is submitted to Jito's block engine as a bundle (a tip ix in a normally-
 * sent tx does nothing) — the landing wiring is built separately; this module just computes the amount + recipient.
 */
import { PublicKey } from '@solana/web3.js';

/** Canonical Jito mainnet tip accounts (public). Randomize across them per Jito guidance to avoid contention. */
export const JITO_TIP_ACCOUNTS: readonly PublicKey[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tm9dWFJPRn8YHzZbL5tWcr8YzMUqQ4xV8d8gMqd',
].map((a) => new PublicKey(a));

/** A conservative tip (lamports) — Valhalla guidance ~0.00005–0.0001 SOL. The cap headroom bounds it further. */
export const CONSERVATIVE_JITO_TIP_LAMPORTS = 50_000; // 0.00005 SOL

/**
 * The Jito tip in lamports: a conservative fixed amount, clamped to the headroom left under the shared cap after
 * the priority fee (so `priority + tip ≤ cap`). Returns 0 when there is no headroom. Pure.
 */
export function jitoTipLamports(capLamports: number, prioritySpentLamports: number): number {
  const headroom = Math.max(0, Math.floor(capLamports) - Math.floor(prioritySpentLamports));
  return Math.min(CONSERVATIVE_JITO_TIP_LAMPORTS, headroom);
}

/** Pick a tip account deterministically from a seed (e.g. a slot/counter) — spreads tips across accounts. Pure. */
export function pickJitoTipAccount(seed: number): PublicKey {
  const i = ((Math.trunc(seed) % JITO_TIP_ACCOUNTS.length) + JITO_TIP_ACCOUNTS.length) % JITO_TIP_ACCOUNTS.length;
  return JITO_TIP_ACCOUNTS[i] as PublicKey;
}

/**
 * Resolve the Jito tip to add to a tx: the recipient account + lamports, or null when Jito is off OR no headroom
 * remains under the cap. Pure — the brain turns this into a SystemProgram.transfer when non-null.
 */
export function jitoTipFor(enabled: boolean, capLamports: number, prioritySpentLamports: number, seed: number): { account: PublicKey; lamports: number } | null {
  if (!enabled) return null;
  const lamports = jitoTipLamports(capLamports, prioritySpentLamports);
  return lamports > 0 ? { account: pickJitoTipAccount(seed), lamports } : null;
}

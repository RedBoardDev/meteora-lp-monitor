/**
 * Wallet-level realized PnL from on-chain SOL cash-flow — the TRUE wallet reality, decoder-free.
 *
 * Position-level PnL (Meteora / LPAgent) stops at the close: it misses the SOL lost AFTER closing,
 * while the leftover token is sold (rugs, slippage). This model instead sums the wallet's own net
 * SOL movement (native + WSOL) across its DLMM + swap txs, day by day. A rug shows up exactly when
 * the dumped token comes back as far less SOL than was deployed. Every lamport is auditable: the sum
 * of all flows equals the wallet's actual SOL balance change over the window.
 *
 * External transfers (funding from / withdrawal to a CEX or another wallet — a plain SOL transfer
 * NOT part of a swap or DLMM action) are NOT trading PnL and are tracked separately, never mixed in.
 */

/** A wallet tx reduced to what the cash-flow model needs (computed from the Helius Enhanced payload). */
export interface WalletTxFlow {
  /** unix seconds */
  timestamp: number;
  type: string;
  /** the wallet's net SOL+WSOL change in this tx (lamports → SOL), signed. */
  solFlow: number;
  /** true when this is trading activity (swap / DLMM lifecycle); false = external transfer / other. */
  isTrading: boolean;
}

/**
 * Decide whether a tx is trading (counts toward wallet PnL) vs an external transfer. Trading = a SWAP,
 * or any tx touching the DLMM program (deposit/withdraw/claim/close). A plain TRANSFER that moves SOL
 * without touching DLMM is external (CEX in/out) and excluded from PnL.
 */
export function classifyTradingByType(type: string, touchesDlmm: boolean): boolean {
  if (type === 'SWAP') return true;
  if (touchesDlmm) return true;
  // INITIALIZE_* / CLOSE_ACCOUNT etc. that touch DLMM are caught by touchesDlmm; a bare TRANSFER is not.
  return false;
}

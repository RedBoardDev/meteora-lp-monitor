/**
 * Copy-bot — a DLMM event detected for a leader, already valued in SOL. DOMAIN type shared between
 * detection (P1: `scripts/leader-detector` + `classify-dlmm-tx`) and the brain (P2: position tracker +
 * decision). One instance = ONE transaction (amounts are aggregated over the tx's legs).
 */
export interface DetectedEvent {
  signature: string;
  blockTime: number | null;
  /** DLMM instruction name (action title); classified via `classifyInstruction`. */
  instruction: string;
  /** capital in (open/add). */
  depositSol: number;
  /** raw NON-SOL token units deposited (open/add), summed over the tx's legs. AUTHORITATIVE two-sided signal — it
   *  comes from the leader's tx decode, so it is independent of the (race-prone) per-bin shape read. 0/absent = one-sided. */
  depositTokenRaw?: number;
  /** capital out (close/remove). */
  withdrawSol: number;
  /** fees harvested (claim). */
  claimSol: number;
  /** the `lbPair` (pool). */
  pool: string;
  /** pubkey of the DLMM position — the tracker's aggregation key; `''` if the tx carries no decodable leg. */
  position: string;
  /** the pool's non-SOL side, or null if the pool is not valuable in SOL. */
  nonSolMint: string | null;
  /** resolved symbol of the non-SOL token (e.g. "USDC"), or null if unknown. */
  nonSolSymbol: string | null;
}

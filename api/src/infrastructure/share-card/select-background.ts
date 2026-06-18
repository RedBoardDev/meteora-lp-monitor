/**
 * Picks the meme background for a PnL card from the realized %:
 *   gain → happy, loss → sad, flat → default.
 *
 * (The original SOLDecoderBot also had `trump` and `summary` variants; we deliberately keep only
 * these three per the product decision.)
 */
export function selectBackground(pct: number): string {
  if (pct > 0) return 'background_happy.png';
  if (pct < 0) return 'background_sad.png';
  return 'background_default.png';
}

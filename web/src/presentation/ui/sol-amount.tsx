'use client';

import { useMoney } from '@/presentation/hooks/use-money';
import { SolMark } from './icons';

/** A formatted amount in the active display currency: SOL with the ◎ mark, or USD ("$…"). Masks to
 *  **** when "hide amounts" is on. */
export function SolAmount({
  n,
  signed = false,
  decimals = 3,
  iconSize = 13,
}: {
  n: number;
  signed?: boolean;
  decimals?: number;
  iconSize?: number;
}) {
  const m = useMoney();
  return (
    <span className="inline-flex items-center gap-1">
      {m.sol(n, { signed, decimals })}
      {m.showGlyph && <SolMark size={iconSize} />}
    </span>
  );
}

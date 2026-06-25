/**
 * Copy-bot · P2.4 — "exit" brick family (PURE). An exit decides whether we close OUR position.
 *
 * First exit = `mirrorLeaderClose`: we follow the leader's close. It's a CORE exit, **ON by default**,
 * **event-driven** (no poll — triggered by the leader's close event, spec 03 §2 / 06 §1.6).
 * The state logic (do we hold an open mirror? have we already closed it?) lives in the `PaperPositionLedger`;
 * this brick carries its metadata/contract. The polled exits (rug-SL 5s, auto-close-OOR 10s) will come here.
 */
import type { BrickMeta } from './bricks';

/** An exit's verdict: close (with a reason) or hold. */
export type ExitVerdict = { action: 'close'; reason: string } | { action: 'hold' };

export interface ExitBrick extends BrickMeta {
  readonly family: 'exit';
}

/** Mirror of the leader's close — ON by default, event-driven (no `pollMs`). */
export const mirrorLeaderCloseBrick: ExitBrick = {
  id: 'mirrorLeaderClose',
  family: 'exit',
  scope: 'per-leader',
  speedClass: 'instant',
  defaultEnabled: true,
};

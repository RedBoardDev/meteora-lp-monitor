import { describe, expect, it } from 'vitest';
import { mirrorLeaderCloseBrick } from './exits';

describe('exits — mirror-leader-close brick (locked defaults)', () => {
  it('mirrorLeaderClose ships ON by default and event-driven (no pollMs)', () => {
    // WHY: spec 06 §1.6 — the mirror of the leader's close is the core exit, ON by default; event-driven
    // (≠ polled rug-SL 5s / OOR 10s) → a pollMs here would be a cadence bug.
    expect(mirrorLeaderCloseBrick).toMatchObject({
      id: 'mirrorLeaderClose',
      family: 'exit',
      scope: 'per-leader',
      speedClass: 'instant',
      defaultEnabled: true,
    });
    expect(mirrorLeaderCloseBrick.pollMs).toBeUndefined();
  });
});

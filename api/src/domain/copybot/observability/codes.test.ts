/**
 * Copy-bot · observability — CODE_REGISTRY invariants (SPEC §2.2). These tests encode the WHY:
 *  - a missing/mistyped meta is a build-or-test error (no silent gaps in the closed code set);
 *  - every legacy reason maps to EXACTLY ONE leaf (locks the back-compat migration — no event re-bucketed twice);
 *  - every user-visible code is renderable (a feed code with no title/template would render blank to the user);
 *  - every critical code can actually REACH the user and is never throttled (a pinned code that is internal or
 *    coalesced = an alert the user would never see — the cardinal sin of the copy-bot's no-miss guarantee).
 */
import { describe, expect, it } from 'vitest';
import { CODE_REGISTRY, type CopyCode, FEED_COALESCE_MS, LEGACY_REASON_ALIASES, PINNED_COALESCE_MS } from './codes';

const ALL_CODES = Object.keys(CODE_REGISTRY) as CopyCode[];

/** Resolve an old journaled reason string to its canonical leaf, mirroring the migration rule (SPEC §2.3). */
function resolveReason(reason: string): CopyCode[] {
  const aliased = (LEGACY_REASON_ALIASES as Record<string, CopyCode>)[reason];
  if (aliased) return [aliased];
  // No alias → the reason must already BE the leaf suffix of exactly one code (`namespace.<reason>`).
  return ALL_CODES.filter((code) => code.slice(code.indexOf('.') + 1) === reason);
}

describe('codes · registry exhaustiveness (SPEC §2.2 test 1)', () => {
  // WHY: `as const satisfies Record<CopyCode, CodeMeta>` makes a malformed entry a *compile* error; this asserts
  // the runtime shape too, so a future hand-edit that drops a required field is caught even outside `tsc`.
  it('every code has a category, severity and audience', () => {
    for (const code of ALL_CODES) {
      const meta = CODE_REGISTRY[code];
      expect(meta.category, code).toBeTruthy();
      expect(meta.severity, code).toBeTruthy();
      expect(meta.audience === 'internal' || meta.audience === 'feed', code).toBe(true);
    }
  });

  it('the registry is non-empty (the closed union actually replaces the ad-hoc strings)', () => {
    expect(ALL_CODES.length).toBeGreaterThan(0);
  });
});

describe('codes · legacy reason migration (SPEC §2.2 test 2)', () => {
  // WHY: the cutover keeps existing journaled `reason` strings working. If an old reason resolved to ZERO leaves
  // the migration would lose an event; if it resolved to TWO it would be ambiguously re-bucketed. Both are bugs.
  it('every alias key maps to exactly one real CopyCode', () => {
    for (const reason of Object.keys(LEGACY_REASON_ALIASES)) {
      const leaves = resolveReason(reason);
      expect(leaves.length, `alias ${reason}`).toBe(1);
      const [leaf] = leaves;
      expect(leaf && CODE_REGISTRY[leaf], `alias ${reason} → ${leaf}`).toBeTruthy();
    }
  });

  // The reasons the producers journal today that the SPEC guarantees a leaf for (verbatim leaf OR via §2.3 alias).
  // Extracted from the live `reason:` literals in src/domain/copybot + src/copybot (P0 = these must all resolve).
  const COVERED_LEGACY_REASONS = [
    // filter (16 verbatim leaves)
    'below_min_market_cap',
    'min_market_cap_unavailable',
    'below_min_holders',
    'min_holders_unavailable',
    'below_min_24h_volume',
    'min_24h_volume_unavailable',
    'below_min_organic_score',
    'min_organic_score_unavailable',
    'below_min_price_range',
    'min_price_range_unavailable',
    'above_max_price_change',
    'max_price_change_unavailable',
    'below_min_token_age',
    'min_token_age_unavailable',
    'ignored_token',
    'single_pool_per_token',
    'entry_filter',
    // cap
    'kill_switch_global',
    'kill_switch_leader',
    'max_open_positions',
    'max_concurrent_per_token',
    'max_opens_per_window',
    'max_total_exposure',
    // sizing / balance (balance via alias)
    'below_min_floor',
    'insufficient_balance',
    // eligibility / reshape (some via alias)
    'non_sol_paired',
    'non_sol_pool',
    'twosided_unbuyable',
    'twosided_token2022_too_wide',
    'reshape_token_unbuyable',
    'partial_range',
    // swap
    'no_residual',
    'below_min_sell_out',
    // sign (Wall A)
    'bad_hmac_or_hop',
    'bad_schema',
    'stale',
    'commandId_mismatch',
    'duplicate',
    'over_max_trade',
    'undecodable_tx',
    'owner_mismatch',
    'dry-run',
    // wall b
    'signer_not_owner',
    'missing_position_signer',
    'pool_not_referenced',
    'foreign_sol_destination',
    'jito_tip_too_large',
    'swap_missing_token_mint',
    'swap_token_not_owner_ata',
    'sol_spend_over_cap',
    'wallb:foreign_sol_destination',
    'wallb:sol_spend_over_cap',
    // failsafe (via alias)
    'leader_closed',
    'orphan',
    'rug_sl',
    // detect
    'leader_position_not_found',
    'not_on_chain_yet',
  ] as const;

  it.each(COVERED_LEGACY_REASONS)('reason %s resolves to exactly one leaf', (reason) => {
    const leaves = resolveReason(reason);
    expect(leaves.length, `${reason} → ${JSON.stringify(leaves)}`).toBe(1);
  });
});

describe('codes · feed renderability (SPEC §2.2 test 3)', () => {
  // WHY: a feed code is what the user reads. Without a title it has no headline; without a render template the
  // user-renderer cannot build a line. Either gap = a blank/empty feed row — silently useless to the user.
  it("every audience:'feed' code has a non-empty title AND a render template", () => {
    for (const code of ALL_CODES) {
      const meta = CODE_REGISTRY[code];
      if (meta.audience !== 'feed') continue;
      expect(meta.title, `${code} title`).toBeTruthy();
      expect(meta.render, `${code} render`).toBeTruthy();
    }
  });
});

describe('codes · pinned guarantees (SPEC §2.2 test 4)', () => {
  // WHY: `pinned` is the no-miss alert channel. A pinned code that is internal could never reach the user; a
  // pinned code with a coalesce window could be throttled away under a burst — both would drop a critical alert
  // (an open/close failure, a failsafe). The copy-bot's #1 pillar is "never miss a close" — lock it here.
  it("every pinned code is audience:'feed' and coalesceMs 0", () => {
    for (const code of ALL_CODES) {
      const meta = CODE_REGISTRY[code];
      if (!meta.pinned) continue;
      expect(meta.audience, `${code} audience`).toBe('feed');
      expect(meta.coalesceMs ?? 0, `${code} coalesceMs`).toBe(PINNED_COALESCE_MS);
    }
  });

  it('the spammy feed codes (filter/cap) carry the 10s coalesce window', () => {
    // WHY: under a leader burst these must collapse into one feed row, not flood it (SPEC §0 D-8 / §6).
    expect(CODE_REGISTRY['filter.below_min_market_cap'].coalesceMs).toBe(FEED_COALESCE_MS);
    expect(CODE_REGISTRY['cap.max_open_positions'].coalesceMs).toBe(FEED_COALESCE_MS);
  });
});

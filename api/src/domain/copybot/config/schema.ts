/**
 * Copy-bot · runtime config — Zod schema + fail-safe parse.
 *
 * `parseConfig` deep-merges a (possibly partial / older-shape) stored blob onto the defaults, then validates — so a
 * missing or newly-added field falls back to its default instead of breaking the whole config, and a structurally
 * invalid blob falls back to the full defaults (the adapter logs that loudly). Also migrates the legacy FLAT blob
 * (`{leader, sizing, caps, twoSidedMode}`) into the two-tier shape so an existing dev config is preserved.
 */
import { z } from 'zod';
import type { CapsConfig } from '../caps';
import type { FilterConfig } from '../filters';
import { type PriorityFeeConfig, PRIORITY_FEE_TIERS } from '../priority-fee';
import type { RugSlConfig } from '../rug-sl';
import type { SizingConfig } from '../sizing';
import { CONFIG_DEFAULTS, DEFAULT_LEADER_ADDRESS, USER_DEFAULTS } from './defaults';
import { type CopybotConfig, type ExecutionConfig, type LeaderSettings, TWO_SIDED_MODES, type UserSettings } from './types';

// Zod mirrors of the reused domain interfaces — `satisfies` keeps each schema in lock-step with its interface.
const SizingSchema = z.object({
  tradeRatioPct: z.number().nullable(),
  maxTradeSizeSol: z.number().positive(),
  minPositionSizeSol: z.number().nonnegative(),
  solReserveSol: z.number().nonnegative(),
  onInsufficient: z.enum(['skip', 'reduceToFit']),
}) satisfies z.ZodType<SizingConfig>;

const CapsSchema = z.object({
  killSwitchGlobal: z.boolean(),
  killSwitchLeader: z.boolean(),
  maxOpenPositions: z.number().int().nonnegative().nullable(),
  maxConcurrentPerToken: z.number().int().nonnegative().nullable(),
  maxOpensPerWindow: z.number().int().nonnegative().nullable(),
  windowMinutes: z.number().nonnegative().nullable(),
  maxTotalExposureSol: z.number().nonnegative().nullable(),
}) satisfies z.ZodType<CapsConfig>;

const TwoSidedSchema = z.enum(TWO_SIDED_MODES);

const FilterConfigSchema = z.object({
  ignoredTokens: z.array(z.string()),
  singlePoolPerToken: z.boolean(),
  minPriceRangePercent: z.number().nullable(),
  minTokenAgeHours: z.number().nullable(),
  minMarketCapUsd: z.number().nullable(),
  min24hVolumeUsd: z.number().nullable(),
  maxPriceChangePercent: z.number().nullable(),
  minJupOrganicScore: z.number().nullable(),
  minHolders: z.number().nullable(),
}) satisfies z.ZodType<FilterConfig>;

const ExecutionSchema = z.object({
  slippageBps: z.number().nonnegative(),
  dustTokenRaw: z.number().int().nonnegative(),
  minSellOutLamports: z.number().int().nonnegative(),
  reshapeBinDeadbandSol: z.number().nonnegative(),
  reshapeBinDeadbandToken: z.number().nonnegative(),
}) satisfies z.ZodType<ExecutionConfig>;

const PriorityFeeSchema = z.object({
  tier: z.enum(PRIORITY_FEE_TIERS),
  maxCapSol: z.number().nonnegative(),
}) satisfies z.ZodType<PriorityFeeConfig>;

const RugSlSchema = z.object({
  enabled: z.boolean(),
  dropPercent: z.number().nonnegative(),
  windowSeconds: z.number().positive(),
}) satisfies z.ZodType<RugSlConfig>;

const UserSchema = z
  .object({ enabled: z.boolean(), sizing: SizingSchema, caps: CapsSchema, twoSidedMode: TwoSidedSchema, filters: FilterConfigSchema, execution: ExecutionSchema, priorityFee: PriorityFeeSchema, rugSl: RugSlSchema })
  .strict() satisfies z.ZodType<UserSettings>;

const LeaderSchema = z
  .object({
    address: z.string().min(1),
    enabled: z.boolean(),
    overrides: z
      .object({
        sizing: SizingSchema.partial().optional(),
        twoSidedMode: TwoSidedSchema.optional(),
        filters: FilterConfigSchema.partial().optional(),
        execution: ExecutionSchema.partial().optional(),
        priorityFee: PriorityFeeSchema.partial().optional(),
        rugSl: RugSlSchema.partial().optional(),
      })
      .strict(),
  })
  .strict() satisfies z.ZodType<LeaderSettings>;

export const CopybotConfigSchema = z
  .object({ user: UserSchema, leaders: z.array(LeaderSchema) })
  .strict() satisfies z.ZodType<CopybotConfig>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null;

/** A stored legacy FLAT blob = `{leader, sizing, caps, twoSidedMode}` (no `user`). */
function isLegacyFlat(o: Obj): boolean {
  return !('user' in o) && ('sizing' in o || 'leader' in o);
}

/** Reshape a legacy flat blob into the two-tier candidate (then merged + validated like any other). */
function fromLegacyFlat(o: Obj): Obj {
  return {
    user: { sizing: o.sizing, caps: o.caps, twoSidedMode: o.twoSidedMode },
    leaders: [{ address: o.leader ?? DEFAULT_LEADER_ADDRESS, enabled: true, overrides: {} }],
  };
}

/** Deep-merge a partial user block onto the user defaults (nested sizing/caps merged field-by-field). */
function mergeUser(partial: unknown): UserSettings {
  const p = isObj(partial) ? partial : {};
  return {
    enabled: typeof p.enabled === 'boolean' ? p.enabled : USER_DEFAULTS.enabled,
    sizing: { ...USER_DEFAULTS.sizing, ...(isObj(p.sizing) ? p.sizing : {}) },
    caps: { ...USER_DEFAULTS.caps, ...(isObj(p.caps) ? p.caps : {}) },
    twoSidedMode: (p.twoSidedMode as UserSettings['twoSidedMode']) ?? USER_DEFAULTS.twoSidedMode,
    filters: { ...USER_DEFAULTS.filters, ...(isObj(p.filters) ? p.filters : {}) },
    execution: { ...USER_DEFAULTS.execution, ...(isObj(p.execution) ? p.execution : {}) },
    priorityFee: { ...USER_DEFAULTS.priorityFee, ...(isObj(p.priorityFee) ? p.priorityFee : {}) },
    rugSl: { ...USER_DEFAULTS.rugSl, ...(isObj(p.rugSl) ? p.rugSl : {}) },
  } as UserSettings;
}

/** Normalize the leaders list (each leader gets defaulted enabled/overrides); empty/missing ⇒ the default leader. */
function mergeLeaders(raw: unknown): LeaderSettings[] {
  if (!Array.isArray(raw) || raw.length === 0) return CONFIG_DEFAULTS.leaders;
  return raw.map((l) => {
    const o = isObj(l) ? l : {};
    return {
      address: typeof o.address === 'string' ? o.address : DEFAULT_LEADER_ADDRESS,
      enabled: typeof o.enabled === 'boolean' ? o.enabled : true,
      overrides: isObj(o.overrides) ? (o.overrides as LeaderSettings['overrides']) : {},
    };
  });
}

/** Parse a stored blob into a validated config. null/invalid ⇒ full defaults; partial ⇒ merged onto defaults. */
export function parseConfig(raw: string | null): CopybotConfig {
  if (raw === null || raw === '') return CONFIG_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return CONFIG_DEFAULTS;
  }
  if (!isObj(parsed)) return CONFIG_DEFAULTS;
  const src = isLegacyFlat(parsed) ? fromLegacyFlat(parsed) : parsed;
  const candidate: CopybotConfig = { user: mergeUser(src.user), leaders: mergeLeaders(src.leaders) };
  const result = CopybotConfigSchema.safeParse(candidate);
  return result.success ? result.data : CONFIG_DEFAULTS;
}

/** Whether a stored blob is a clean, fully-valid config (used by the adapter to warn loudly on corruption). */
export function isValidConfigBlob(raw: string | null): boolean {
  if (raw === null || raw === '') return false;
  try {
    const parsed = JSON.parse(raw);
    if (!isObj(parsed)) return false;
    const src = isLegacyFlat(parsed) ? fromLegacyFlat(parsed) : parsed;
    return CopybotConfigSchema.safeParse({ user: mergeUser(src.user), leaders: mergeLeaders(src.leaders) }).success;
  } catch {
    return false;
  }
}

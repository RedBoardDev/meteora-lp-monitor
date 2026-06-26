/**
 * Copy-bot · runtime configuration — PURE schema + defaults (no I/O).
 *
 * The web-tunable surface of the bot: which leader, sizing, safety caps + kill-switch, and the two-sided mode.
 * Persisted as ONE JSON blob in the `settings` table (key `copybot.config`) so the web edits it live and the bot
 * reloads it without a restart. Infra/secret config (RPC/WS/Redis/DB URLs, HMAC key, owner pubkey, keypair path)
 * is NOT here — it stays in the environment.
 *
 * Robustness: `parseConfig` deep-merges a (possibly partial / older-schema) stored blob onto the defaults, then
 * validates — so a missing or newly-added field falls back to its default instead of breaking the whole config,
 * and a structurally invalid blob falls back to the full defaults (the adapter logs that loudly).
 */
import { z } from 'zod';
import { CAPS_DEFAULTS, type CapsConfig } from './caps';
import type { SizingConfig } from './sizing';

export const TWO_SIDED_MODES = ['off', 'shadow', 'on'] as const;
export type TwoSidedMode = (typeof TWO_SIDED_MODES)[number];

// Zod mirrors of the reused domain interfaces — `satisfies` keeps each schema in lock-step with its interface
// (a field added to SizingConfig/CapsConfig that the schema misses becomes a compile error here).
const SizingSchema = z.object({
  tradeRatioPct: z.number().nullable(), // null = fixed-size mode
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

export const CopybotConfigSchema = z
  .object({
    leader: z.string().min(1),
    sizing: SizingSchema,
    caps: CapsSchema,
    twoSidedMode: z.enum(TWO_SIDED_MODES),
  })
  .strict();

export type CopybotRuntimeConfig = z.infer<typeof CopybotConfigSchema>;

/** A partial override (what the web may store) — each field optional, nested objects partially overridable. */
export interface ConfigOverride {
  leader?: string;
  sizing?: Partial<SizingConfig>;
  caps?: Partial<CapsConfig>;
  twoSidedMode?: TwoSidedMode;
}

/** Defaults = the values previously hard-coded from the environment. The single source of truth for a fresh bot. */
export const CONFIG_DEFAULTS: CopybotRuntimeConfig = {
  leader: '8ryctvNwpJTuuap3wuNTfcyEx4DjSuXvhGXSDHNaU8sQ',
  sizing: { tradeRatioPct: 50, maxTradeSizeSol: 1.0, minPositionSizeSol: 0.05, solReserveSol: 0.05, onInsufficient: 'skip' },
  caps: { ...CAPS_DEFAULTS },
  twoSidedMode: 'off',
};

/** Deep-merge an override onto a base (nested sizing/caps merged field-by-field). Pure; never mutates inputs. */
export function mergeConfig(base: CopybotRuntimeConfig, override: ConfigOverride): CopybotRuntimeConfig {
  return {
    leader: override.leader ?? base.leader,
    sizing: { ...base.sizing, ...(override.sizing ?? {}) },
    caps: { ...base.caps, ...(override.caps ?? {}) },
    twoSidedMode: override.twoSidedMode ?? base.twoSidedMode,
  };
}

/**
 * Parse a stored config blob into a validated runtime config. `null`/invalid-JSON/structurally-invalid → full
 * defaults; a partial blob is merged onto the defaults so unset/new fields keep their default. Pure (no logging).
 */
export function parseConfig(raw: string | null): CopybotRuntimeConfig {
  if (raw === null || raw === '') return CONFIG_DEFAULTS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return CONFIG_DEFAULTS;
  }
  if (typeof parsed !== 'object' || parsed === null) return CONFIG_DEFAULTS;
  const merged = mergeConfig(CONFIG_DEFAULTS, parsed as ConfigOverride);
  const result = CopybotConfigSchema.safeParse(merged);
  return result.success ? result.data : CONFIG_DEFAULTS;
}

/** Whether a stored blob is a clean, fully-valid config (used by the adapter to warn loudly on corruption). */
export function isValidConfigBlob(raw: string | null): boolean {
  if (raw === null || raw === '') return false;
  try {
    return CopybotConfigSchema.safeParse(mergeConfig(CONFIG_DEFAULTS, JSON.parse(raw) as ConfigOverride)).success;
  } catch {
    return false;
  }
}

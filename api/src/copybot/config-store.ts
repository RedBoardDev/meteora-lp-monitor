/**
 * Copy-bot · runtime config persistence (`settings` table, key `copybot.config`). The web writes here; the bot
 * reads/reloads here. ONE JSON blob = an atomic config swap (no half-applied multi-row update).
 *
 * - `load()` is fail-safe: a missing/corrupt blob yields the full defaults (logged LOUDLY so corruption is never
 *   silent — Rule 11). It never throws, so a config read can't crash the bot.
 * - `save()` VALIDATES and throws on an invalid config: the web caller must get a clear error, never persist junk.
 * - `seedIfAbsent()` writes the defaults on first boot so the web has a concrete config to edit.
 */
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { CONFIG_DEFAULTS, type CopybotConfig, CopybotConfigSchema, isValidConfigBlob, parseConfig } from '@/domain/copybot/config';
import type { openDatabase } from '@/infrastructure/persistence/database';
import { settings } from '@/infrastructure/persistence/schema';

const CONFIG_KEY = 'copybot.config';
type Db = ReturnType<typeof openDatabase>;

export class ConfigStore {
  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  private async readRaw(): Promise<string | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, CONFIG_KEY));
    return rows[0]?.value ?? null;
  }

  /** Current runtime config (defaults if unset/corrupt; corruption is logged loudly, never silently swallowed). */
  async load(): Promise<CopybotConfig> {
    const raw = await this.readRaw();
    if (raw !== null && !isValidConfigBlob(raw)) {
      this.log.error({ raw }, 'copybot config blob is invalid → falling back to DEFAULTS (fix it via the web)');
    }
    return parseConfig(raw);
  }

  /** Persist a full config. Validates first → throws on invalid so the web caller never stores junk. */
  async save(cfg: CopybotConfig): Promise<void> {
    const valid = CopybotConfigSchema.parse(cfg); // throws ZodError on invalid (loud, caller-facing)
    const value = JSON.stringify(valid);
    await this.db.insert(settings).values({ key: CONFIG_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }

  /** First-boot seed: write the defaults if absent, then return the effective config. */
  async seedIfAbsent(): Promise<CopybotConfig> {
    const raw = await this.readRaw();
    if (raw !== null) return parseConfig(raw);
    await this.save(CONFIG_DEFAULTS);
    this.log.info('copybot config seeded with DEFAULTS');
    return CONFIG_DEFAULTS;
  }
}

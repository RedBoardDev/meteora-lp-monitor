/**
 * Copy-bot · runtime config persistence (`settings` table, key `copybot.config`). The web writes here; the bot
 * reads/reloads here. ONE JSON blob = an atomic config swap (no half-applied multi-row update).
 *
 * - `load()` is fail-safe AND fail-CLOSED: a missing blob (genuine first run) yields the full defaults; a CORRUPT
 *   blob does NOT (returning the permissive `enabled:true`/`killSwitchGlobal:false` defaults would silently re-enable
 *   trading — a safety switch that fails OPEN). On corruption it returns the last known-good config (or defaults if
 *   none yet) with the GLOBAL kill switch FORCED ON, logged LOUDLY (Rule 11). It never throws, so a read can't crash
 *   the bot.
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

/**
 * Return a copy of `cfg` with the GLOBAL kill switch forced ON. Used to fail CLOSED on a corrupt config blob:
 * whatever the last-good config was, halt every leader's opens until the blob is repaired. `caps.killSwitchGlobal`
 * is the account-wide halt that `checkCaps` reads (see caps.ts / config/effective.ts).
 */
function withKillSwitchOn(cfg: CopybotConfig): CopybotConfig {
  return { ...cfg, user: { ...cfg.user, caps: { ...cfg.user.caps, killSwitchGlobal: true } } };
}

export class ConfigStore {
  /**
   * Last cleanly-parsed config, cached on every VALID load (including genuine first-run defaults). A later CORRUPT
   * blob fails CLOSED to this last known-good with the kill switch forced ON, instead of reverting to the permissive
   * trading-enabled defaults.
   */
  private lastGood: CopybotConfig | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
  ) {}

  private async readRaw(): Promise<string | null> {
    const rows = await this.db.select().from(settings).where(eq(settings.key, CONFIG_KEY));
    return rows[0]?.value ?? null;
  }

  /** Current runtime config. Unset ⇒ defaults; CORRUPT ⇒ fail-closed (last-good/defaults, kill switch forced ON). */
  async load(): Promise<CopybotConfig> {
    const raw = await this.readRaw();
    if (raw !== null && !isValidConfigBlob(raw)) {
      // A stored blob exists but is corrupt/unparseable (partial write, manual edit, or a schema tightening that now
      // rejects the old shape). Returning the permissive DEFAULTS here would silently flip `enabled:true` /
      // `killSwitchGlobal:false` and re-enable trading within the ~5s reload — the safety switch would fail OPEN.
      // Fail CLOSED instead: last known-good (or defaults if none yet) with the global kill switch forced ON, so the
      // bot stays halted until an operator repairs the blob.
      // TODO(follow-up): config corruption warrants a PINNED operator alert; the ConfigStore has no CopyEvents emitter
      // wired in yet, so keep the loud error log here and add the pinned alert when the emitter is reachable.
      this.log.error({ raw }, 'copybot config blob is invalid → FAIL-CLOSED (global kill switch forced ON until repaired)');
      return withKillSwitchOn(this.lastGood ?? CONFIG_DEFAULTS);
    }
    const cfg = parseConfig(raw); // null/'' ⇒ genuine first-run DEFAULTS; valid/partial ⇒ merged-and-validated config
    this.lastGood = cfg; // cache the known-good config so the next corrupt blob can fail closed to it
    return cfg;
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

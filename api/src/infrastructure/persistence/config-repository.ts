import {
  type EventKind,
  EventKindSchema,
  type NotifRule,
  type RuntimeSettings,
} from '@meteora/shared';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { ConfigRepository } from '@/domain/ports';
import { toFiniteNumber as num } from '@/util/number';
import type { Database } from './database';
import { notifRules as notifRulesTable, settings as settingsTable } from './schema';

/**
 * Runtime settings and notification rules (owner-scoped; wallets live in AccountRepository).
 * Reads are served from in-memory caches (loaded by `init()`, refreshed on every write) so hot,
 * synchronous callers — the poll-interval math, the Bark-key getter — never await the database.
 */
export class PostgresConfigRepository implements ConfigRepository {
  private settingsCache: RuntimeSettings;
  private rulesCache: NotifRule[] = [];

  constructor(
    private readonly db: Database,
    private readonly defaults: RuntimeSettings,
  ) {
    this.settingsCache = { ...defaults };
  }

  async init(): Promise<void> {
    await this.dedupeGlobalRules();
    await this.pruneUnknownRules();
    await this.seedDefaultRules();
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.settingsCache = await this.loadSettings();
    this.rulesCache = await this.loadRules();
  }

  // --- settings ---
  getSettings(): RuntimeSettings {
    return this.settingsCache;
  }

  async saveSettings(s: Partial<RuntimeSettings>): Promise<RuntimeSettings> {
    const entries = Object.entries(s).filter(([, v]) => v !== undefined);
    if (entries.length > 0) {
      await this.db
        .insert(settingsTable)
        .values(entries.map(([key, value]) => ({ key, value: String(value) })))
        .onConflictDoUpdate({ target: settingsTable.key, set: { value: sql`excluded.value` } });
    }
    this.settingsCache = await this.loadSettings();
    return this.settingsCache;
  }

  private async loadSettings(): Promise<RuntimeSettings> {
    const rows = await this.db.select().from(settingsTable);
    const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      meteoraTargetRps: num(stored.meteoraTargetRps, this.defaults.meteoraTargetRps),
      pollMinMs: num(stored.pollMinMs, this.defaults.pollMinMs),
      pollMaxMs: num(stored.pollMaxMs, this.defaults.pollMaxMs),
      pollIdleMs: num(stored.pollIdleMs, this.defaults.pollIdleMs),
      barkKey: stored.barkKey ?? this.defaults.barkKey,
      presenceTimeoutSeconds: num(
        stored.presenceTimeoutSeconds,
        this.defaults.presenceTimeoutSeconds,
      ),
    };
  }

  // --- notification rules ---
  listNotifRules(): NotifRule[] {
    return this.rulesCache;
  }

  async saveNotifRule(rule: NotifRule): Promise<void> {
    await this.writeRule(rule);
    this.rulesCache = await this.loadRules();
  }

  /**
   * Update-or-insert keyed on (COALESCE(wallet,''), event_kind) — handles global (NULL wallet) and
   * per-wallet rules uniformly. NULL is DISTINCT in a plain unique index, so ON CONFLICT can't key
   * global rules; do it explicitly.
   */
  private async writeRule(rule: NotifRule): Promise<void> {
    const walletMatch =
      rule.wallet === null
        ? isNull(notifRulesTable.wallet)
        : eq(notifRulesTable.wallet, rule.wallet);
    const updated = await this.db
      .update(notifRulesTable)
      .set({
        enabled: rule.enabled,
        mode: rule.mode,
        threshold: rule.threshold,
        oorMinutes: rule.oorMinutes,
      })
      .where(and(walletMatch, eq(notifRulesTable.eventKind, rule.eventKind)))
      .returning({ k: notifRulesTable.eventKind });
    if (updated.length === 0) {
      await this.db.insert(notifRulesTable).values({
        wallet: rule.wallet,
        eventKind: rule.eventKind,
        enabled: rule.enabled,
        mode: rule.mode,
        threshold: rule.threshold,
        oorMinutes: rule.oorMinutes,
      });
    }
  }

  private async loadRules(): Promise<NotifRule[]> {
    const rows = await this.db.select().from(notifRulesTable);
    return rows.map((r) => ({
      wallet: r.wallet ?? null,
      eventKind: r.eventKind as EventKind,
      enabled: Boolean(r.enabled),
      mode: (r.mode as 'single' | 'bulk') ?? 'single',
      threshold: r.threshold == null ? null : Number(r.threshold),
      oorMinutes: r.oorMinutes == null ? null : Number(r.oorMinutes),
    }));
  }

  /** Drop rules for event kinds no longer in the contract. */
  private async pruneUnknownRules(): Promise<void> {
    await this.db
      .delete(notifRulesTable)
      .where(notInArray(notifRulesTable.eventKind, [...EventKindSchema.options]));
  }

  /** Collapse duplicate global rules (legacy data); idempotent. */
  private async dedupeGlobalRules(): Promise<void> {
    await this.db.execute(sql`
      delete from notif_rules a using notif_rules b
      where a.wallet is null and b.wallet is null and a.event_kind = b.event_kind and a.ctid < b.ctid`);
  }

  private async seedDefaultRules(): Promise<void> {
    const existing = new Set(
      (
        await this.db
          .select({ k: notifRulesTable.eventKind })
          .from(notifRulesTable)
          .where(isNull(notifRulesTable.wallet))
      ).map((r) => r.k),
    );
    for (const kind of EventKindSchema.options) {
      if (existing.has(kind)) continue;
      await this.writeRule({
        wallet: null,
        eventKind: kind,
        enabled: kind === 'position_open' || kind === 'position_close' || kind.startsWith('oor'),
        mode: 'single',
        threshold: kind === 'pnl_threshold' ? 0.5 : kind === 'fees_threshold' ? 0.1 : null,
        oorMinutes: kind === 'oor_duration' ? 15 : null,
      });
    }
  }
}

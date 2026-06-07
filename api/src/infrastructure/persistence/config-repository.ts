import {
  type EventKind,
  EventKindSchema,
  type NotifRule,
  type RuntimeSettings,
} from '@meteora/shared';
import type { ConfigRepository } from '@/domain/ports';
import type { Db } from './database';

/** Wallets, runtime settings (overridable from the UI) and notification rules. */
export class SqliteConfigRepository implements ConfigRepository {
  constructor(
    private readonly db: Db,
    private readonly defaults: RuntimeSettings,
  ) {
    this.dedupeGlobalRules();
    this.pruneUnknownRules();
    this.seedDefaultRules();
  }

  listWallets() {
    return (
      this.db.prepare(`SELECT address, label, color, created_at FROM wallets`).all() as {
        address: string;
        label: string;
        color: string | null;
        created_at: number;
      }[]
    ).map((r) => ({
      address: r.address,
      label: r.label,
      color: r.color ?? undefined,
      createdAt: r.created_at,
    }));
  }

  addWallet(w: { address: string; label: string; color?: string }): void {
    this.db
      .prepare(
        `INSERT INTO wallets (address, label, color, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET label=excluded.label, color=excluded.color`,
      )
      .run(w.address, w.label, w.color ?? null, Date.now());
  }

  removeWallet(address: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM wallets WHERE address=?`).run(address);
      this.db.prepare(`DELETE FROM positions WHERE wallet=?`).run(address);
      this.db.prepare(`DELETE FROM sync_state WHERE wallet=?`).run(address);
    });
    tx();
  }

  getSettings(): RuntimeSettings {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as {
      key: string;
      value: string;
    }[];
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

  saveSettings(s: Partial<RuntimeSettings>): RuntimeSettings {
    const stmt = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    );
    const tx = this.db.transaction(() => {
      for (const [k, v] of Object.entries(s)) {
        if (v !== undefined) stmt.run(k, String(v));
      }
    });
    tx();
    return this.getSettings();
  }

  listNotifRules(): NotifRule[] {
    const rows = this.db.prepare(`SELECT * FROM notif_rules`).all() as Record<string, unknown>[];
    return rows.map((r) => ({
      wallet: (r.wallet as string) ?? null,
      eventKind: r.event_kind as EventKind,
      enabled: Boolean(r.enabled),
      mode: (r.mode as 'single' | 'bulk') ?? 'single',
      threshold: r.threshold == null ? null : Number(r.threshold),
      oorMinutes: r.oor_minutes == null ? null : Number(r.oor_minutes),
    }));
  }

  saveNotifRule(rule: NotifRule): void {
    const params = {
      wallet: rule.wallet,
      eventKind: rule.eventKind,
      enabled: rule.enabled ? 1 : 0,
      mode: rule.mode,
      threshold: rule.threshold,
      oorMinutes: rule.oorMinutes,
    };
    // SQLite treats NULL as DISTINCT in the (wallet, event_kind) primary key, so ON CONFLICT
    // never fires for global rules — update-or-insert manually to avoid duplicate rows.
    if (rule.wallet === null) {
      const upd = this.db
        .prepare(
          `UPDATE notif_rules SET enabled=@enabled, mode=@mode, threshold=@threshold,
             oor_minutes=@oorMinutes WHERE wallet IS NULL AND event_kind=@eventKind`,
        )
        .run(params);
      if (upd.changes === 0) {
        this.db
          .prepare(
            `INSERT INTO notif_rules (wallet, event_kind, enabled, mode, threshold, oor_minutes)
             VALUES (@wallet, @eventKind, @enabled, @mode, @threshold, @oorMinutes)`,
          )
          .run(params);
      }
      return;
    }
    this.db
      .prepare(
        `INSERT INTO notif_rules (wallet, event_kind, enabled, mode, threshold, oor_minutes)
         VALUES (@wallet, @eventKind, @enabled, @mode, @threshold, @oorMinutes)
         ON CONFLICT(wallet, event_kind) DO UPDATE SET
           enabled=@enabled, mode=@mode, threshold=@threshold, oor_minutes=@oorMinutes`,
      )
      .run(params);
  }

  /** Drop rules for event kinds no longer in the contract (removed phantom kinds). */
  private pruneUnknownRules(): void {
    const valid = EventKindSchema.options;
    const placeholders = valid.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM notif_rules WHERE event_kind NOT IN (${placeholders})`)
      .run(...valid);
  }

  /** Collapse duplicate global rules (NULL wallet) left by the pre-fix ON CONFLICT bug. */
  private dedupeGlobalRules(): void {
    this.db.exec(
      `DELETE FROM notif_rules WHERE wallet IS NULL AND rowid NOT IN (
         SELECT MAX(rowid) FROM notif_rules WHERE wallet IS NULL GROUP BY event_kind
       )`,
    );
  }

  private seedDefaultRules(): void {
    const existing = new Set(
      (
        this.db.prepare(`SELECT event_kind FROM notif_rules WHERE wallet IS NULL`).all() as {
          event_kind: string;
        }[]
      ).map((r) => r.event_kind),
    );
    for (const kind of EventKindSchema.options) {
      if (existing.has(kind)) continue;
      this.saveNotifRule({
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

function num(v: string | undefined, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

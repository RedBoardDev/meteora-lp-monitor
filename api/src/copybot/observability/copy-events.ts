/**
 * Copy-bot · observability — `CopyEvents` emitter (I/O adapter, SPEC §4).
 *
 * The ONE service brain + coffre call instead of `log.*` / `alert()` / `journal.record()`. It assembles a typed
 * `CopyEvent`, dedups it (in-process LRU keyed on `(correlationId, code)`), mirrors it to pino as flat admin JSON
 * via `toAdminJson`, and persists it through `EventStore` (`persistDurable` for `pinned`, else fire-and-forget).
 *
 * NEVER throws (the journal contract is fire-and-forget — a logging hiccup must not break the hot path nor cause a
 * missed open/close, the copy-bot's #1 pillar). `assemble` is PURE and unit-tested; the constructor binds the
 * tenant `CopyEventContext` once (like `process` on the journal store today).
 */
import type { Logger } from 'pino';
import {
  CODE_REGISTRY,
  type CopyCode,
  EMIT_DEDUP_TTL_MS,
} from '@/domain/copybot/observability/codes';
import type { CopyEvent, CopyEventContext, CopySeverity } from '@/domain/copybot/observability/event';
import type { EmitInput } from '@/domain/copybot/observability/input';
import { toAdminJson } from '@/domain/copybot/observability/render-admin';
import type { EventStore } from './event-store';

/** Max distinct `(correlationId, code)` keys held in the dedup LRU before the oldest is evicted. */
const DEDUP_LRU_MAX = 10_000;

/** Map a `CopySeverity` to the pino method name (the admin mirror logs at the code's severity, SPEC §4). */
function level(severity: CopySeverity): 'info' | 'warn' | 'error' {
  return severity;
}

/**
 * PURE: build a `CopyEvent` from a code, its registry meta, the call-site `fields`, the bound context, and a stamp.
 * Denormalizes severity/category/audience/pinned from the registry and threads `correlationId = commandId ??
 * eventKey` (the dedup key, SPEC §6). The user message is left undefined here — it is built lazily by the renderer
 * for feed-visible rows (SPEC §1). Exported for direct unit testing.
 */
export function assemble<C extends CopyCode>(
  code: C,
  fields: EmitInput<C>,
  base: CopyEventContext,
  ts: number,
): CopyEvent {
  const meta = CODE_REGISTRY[code];
  const correlationId = fields.correlationId ?? fields.commandId ?? fields.eventKey;
  return {
    ...fields,
    code,
    severity: meta.severity,
    category: meta.category,
    audience: meta.audience,
    pinned: meta.pinned ?? false,
    ts,
    eventTs: fields.eventTs ?? ts,
    ctx: base,
    correlationId,
  };
}

/**
 * In-process LRU of recently-emitted `(correlationId, code)` keys. WS + cursor-poll double-detect collapse to one
 * emit within `EMIT_DEDUP_TTL_MS` (SPEC §6); the DB unique index is the durable backstop. Insertion-ordered Map =
 * a cheap LRU (delete+set re-inserts at the tail; `keys().next()` is the oldest).
 */
class EmitDedup {
  private readonly seenAt = new Map<string, number>();

  /** Returns true if `key` was already seen within the TTL (caller drops the emit); records it otherwise. */
  seen(key: string, now: number): boolean {
    const at = this.seenAt.get(key);
    if (at !== undefined && now - at < EMIT_DEDUP_TTL_MS) {
      return true;
    }
    this.seenAt.delete(key);
    this.seenAt.set(key, now);
    if (this.seenAt.size > DEDUP_LRU_MAX) {
      const oldest = this.seenAt.keys().next().value;
      if (oldest !== undefined) this.seenAt.delete(oldest);
    }
    return false;
  }
}

export class CopyEvents {
  private readonly dedup = new EmitDedup();

  constructor(
    private readonly store: EventStore,
    private readonly log: Logger,
    private readonly base: CopyEventContext,
    /**
     * OPTIONAL external alert sink (e.g. an `ALERT_WEBHOOK` POST) — fired fire-and-forget for operator-actionable
     * (`pinned`) events only, so the durable/feed-visible set also reaches the out-of-band channel. Best-effort:
     * the sink MUST never throw (its call is guarded by the `emit` loop guard) and is absent (no-op) without config.
     */
    private readonly alertSink?: (e: CopyEvent) => void,
  ) {}

  /** The bound tenant context (read-only) — the shims reuse it (e.g. to know the bound `process`). */
  get context(): CopyEventContext {
    return this.base;
  }

  /**
   * Emit a typed event: assemble → dedup → admin pino mirror → persist. Fire-and-forget, NEVER throws (the whole
   * body is guarded; a logging failure must never propagate into the hot path).
   */
  emit<C extends CopyCode>(code: C, fields: EmitInput<C>): void {
    try {
      const e = assemble(code, fields, this.base, Date.now());
      const dedupKey = `${e.correlationId ?? ''}:${code}`;
      if (this.dedup.seen(dedupKey, e.ts)) return; // WS + poll collapse to one row (SPEC §6)
      this.log[level(e.severity)](toAdminJson(e), code); // structured admin mirror (sync)
      if (e.pinned) {
        void this.store.persistDurable(e); // critical: durable (awaited inside the store; never throws)
        // Operator-actionable ("VERIFY/CLOSE MANUALLY"): also fan out to the external alert channel. Fire-and-forget,
        // guarded by this try (a throwing sink must not break the hot path). No-op sink when ALERT_WEBHOOK is unset.
        this.alertSink?.(e);
      } else {
        void this.store.persist(e); // fire-and-forget
      }
    } catch (err) {
      // Defensive loop guard: even an assembly bug must not break the bot. Log loud, swallow.
      this.log.error({ err: (err as Error).message, code }, 'copy-events: emit failed (non-fatal)');
    }
  }

  // ── intent sugar (all → emit) — thin, ergonomic wrappers per SPEC §4 ─────────────────────────────────────────

  /** A copied position open confirmed on-chain (brain owns it — only it has the Mirror). */
  opened(fields: EmitInput<'lifecycle.open_confirmed'>): void {
    this.emit('lifecycle.open_confirmed', fields);
  }

  /** A copied position close confirmed on-chain. */
  closed(fields: EmitInput<'lifecycle.close_confirmed'>): void {
    this.emit('lifecycle.close_confirmed', fields);
  }

  /** Liquidity added to a copied position (reshape add). */
  addedLiquidity(fields: EmitInput<'lifecycle.add_confirmed'>): void {
    this.emit('lifecycle.add_confirmed', fields);
  }

  /** A proportional partial remove on a copied position. */
  removedPartial(fields: EmitInput<'lifecycle.remove_partial'>): void {
    this.emit('lifecycle.remove_partial', fields);
  }

  /** Fees claimed on a copied position. */
  claimed(fields: EmitInput<'lifecycle.claim_confirmed'>): void {
    this.emit('lifecycle.claim_confirmed', fields);
  }

  /** A residual token → SOL swap executed. */
  swapped(fields: EmitInput<'swap.executed'>): void {
    this.emit('swap.executed', fields);
  }

  /** A swap failed after retries (pinned — must reach the feed, "swap manually"). */
  swapFailed(fields: EmitInput<'swap.failed_after_retries'>): void {
    this.emit('swap.failed_after_retries', fields);
  }

  /** A failsafe (safety re-close / orphan / rug-SL) outcome — `ok` selects activated vs failed. Pinned. */
  failsafe(ok: boolean, fields: EmitInput<'failsafe.activated'>): void {
    this.emit(ok ? 'failsafe.activated' : 'failsafe.failed', fields);
  }

  /** A copy was skipped because the configured balance is insufficient (pinned, balance line labelled). */
  insufficientBalance(fields: EmitInput<'balance.insufficient'>): void {
    this.emit('balance.insufficient', fields);
  }

  /** A no-copy SKIP under a known code (filter / sizing / eligibility / detect — "why no copy", transparency). */
  skipped<C extends CopyCode>(code: C, fields: EmitInput<C>): void {
    this.emit(code, fields);
  }

  /** A no-copy BLOCK under a known cap code (max open / per-token / per-window / total exposure / kill-switch). */
  blocked<C extends CopyCode>(code: C, fields: EmitInput<C>): void {
    this.emit(code, fields);
  }

  /** A system/observability event under a known `system.*` (or `failsafe.*`) code, optionally carrying an error. */
  system<C extends CopyCode>(code: C, err: unknown, fields: EmitInput<C>): void {
    this.emit(code, err === undefined ? fields : { ...fields, cause: serializeCause(err) });
  }

  /**
   * P1 SHIM PATH (behavior-preserving): persist a pre-assembled `CopyEvent` WITHOUT the admin pino mirror and
   * WITHOUT the dedup LRU. The legacy `journal.record()` / `alert()` shims already write their own formatted
   * stdout line (the legacy mirror) and must not change its count, so this method only routes the row to the
   * `EventStore` so the new tenant/correlation/columns back-fill. Honors `pinned` (durable). NEVER throws.
   *
   * Removed in P2 once the call sites emit typed codes directly through `emit`.
   */
  recordAssembled(e: CopyEvent): void {
    try {
      if (e.pinned) {
        void this.store.persistDurable(e);
      } else {
        void this.store.persist(e);
      }
    } catch (err) {
      this.log.error({ err: (err as Error).message, code: e.code }, 'copy-events: shim persist failed (non-fatal)');
    }
  }

  /**
   * P1 SHIM PATH (awaited): like `recordAssembled` but AWAITS the durable write, so a caller that awaits the
   * journal (e.g. `journal.record()` and the integration tests that read the row immediately after) sees the row
   * on disk before continuing. Still NEVER throws — `EventStore.persistDurable` swallows + logs loud internally.
   * Production call sites fire-and-forget (`void journal.record(...)`), so this adds no latency to the hot path.
   */
  async recordAssembledDurable(e: CopyEvent): Promise<void> {
    await this.store.persistDurable(e);
  }
}

/** Serialize a thrown value into the JSON-safe `cause` record a `CopyEvent` carries (NOT a live Error). */
export function serializeCause(err: unknown): CopyEvent['cause'] {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: 'NonError', message: String(err) };
}

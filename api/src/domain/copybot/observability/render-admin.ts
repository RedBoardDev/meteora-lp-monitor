/**
 * Copy-bot · observability — admin renderer (PURE: no I/O, no SDK, no DB).
 *
 * `toAdminJson(e)` projects a `CopyEvent` into the FLAT structured object the adapter logs at `e.severity` (pino)
 * and persists. No decorative emoji — this is the debug surface, queried by `WHERE wallet=$1 ORDER BY ts DESC`
 * (or `code LIKE 'wallb.%'`, `correlation_id`, `leader`). Every field is included; `cause` is serialized in
 * (it is already a plain `{name,message,stack}` on the event, not a live Error). Identical live and on replay
 * (SPEC §3.1).
 */
import type { CopyEvent } from './event';

/**
 * Flatten a `CopyEvent` to a single-level admin JSON record. `undefined` fields are omitted so the structured log
 * stays compact; the tenancy `ctx` is hoisted to flat `userId` / `wallet` / `process` (the documented filter keys).
 */
export function toAdminJson(e: CopyEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: e.code,
    severity: e.severity,
    category: e.category,
    audience: e.audience,
    pinned: e.pinned,
    ts: e.ts,
    eventTs: e.eventTs,
    // Tenancy hoisted flat (the admin/user filter keys) — see SPEC §3.1 / §7.
    userId: e.ctx.userId,
    wallet: e.ctx.wallet,
    process: e.ctx.process,
    stage: e.stage,
    outcome: e.outcome,
  };

  // Optional scalars — included only when present so the row is not littered with nulls.
  putIfDefined(out, 'correlationId', e.correlationId);
  putIfDefined(out, 'commandId', e.commandId);
  putIfDefined(out, 'eventKey', e.eventKey);
  putIfDefined(out, 'leader', e.leader);
  putIfDefined(out, 'pool', e.pool);
  putIfDefined(out, 'leaderPosition', e.leaderPosition);
  putIfDefined(out, 'ourPosition', e.ourPosition);
  putIfDefined(out, 'kind', e.kind);
  putIfDefined(out, 'reason', e.reason);
  putIfDefined(out, 'leaderSizeSol', e.leaderSizeSol);
  putIfDefined(out, 'ourSizeSol', e.ourSizeSol);
  putIfDefined(out, 'signature', e.signature);
  putIfDefined(out, 'latencyMs', e.latencyMs);
  putIfDefined(out, 'adminDetail', e.adminDetail);

  // `cause` is serialized in (admin-only). It is a plain record on the event — re-emit it flat so a query on the
  // admin row can read the failure name/message/stack without re-parsing a nested Error.
  if (e.cause) {
    out.causeName = e.cause.name;
    out.causeMessage = e.cause.message;
    putIfDefined(out, 'causeStack', e.cause.stack);
  }

  return out;
}

/** Set `key` only when `value` is defined — keeps the flat admin record free of explicit `undefined` entries. */
function putIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

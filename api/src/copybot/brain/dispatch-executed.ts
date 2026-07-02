/**
 * Copy-bot · BRAIN — `ev:executed` per-message dispatch (pure glue, extracted for testability + error isolation).
 *
 * The brain consumes the vault's `ev:executed` stream to react to LANDED commands (a close → prompt markClosed +
 * residual sell; a buy → build the deferred open/reshape add; a create → the Token-2022 deposit; observability
 * confirms). Missing a confirmation — ESPECIALLY a close — is forbidden (robustness pillar), so this mirrors the
 * COFFRE's proven consume pattern (coffre-main `processBatch`):
 *   · EACH message is dispatched under its OWN try/catch — a throwing handler (a DB blip in `onCloseConfirmed`, a
 *     failed ack, …) is recorded and the loop CONTINUES to the next message; it is NOT acked, so it stays in the PEL.
 *   · The caller drains the PEL (`consumePending`) before each `'>'` read, so a delivered-but-unACKed message
 *     (left by a transient throw or a same-process restart) is re-delivered for an idempotent retry.
 *
 * All handlers are idempotent on re-delivery: `onCloseConfirmed` → markClosed no-ops once the mirror is closed;
 * the deferred-publish handlers (`publish*AfterBuy` / `publishDepositAfterPositionCreated` / `finalizeToken2022Open`)
 * consume a delete-on-use pending map keyed by a deterministic commandId, so a re-run after success is a clean
 * no-op; the `*Confirmed` handlers are observability-only (emit-deduped).
 */

/** The subset of an `ev:executed` payload the dispatch reads (kind + the correlation keys). */
export interface ExecutedEvent {
  kind?: string;
  pool?: string;
  positionPubkey?: string;
  commandId?: string;
  sig?: string;
}

/** The handler callbacks the dispatch routes to. The async ones may reject on a transient failure (the caller's
 *  per-message guard isolates it); the sync `*Confirmed` handlers are observability-only and never throw. */
export interface DispatchExecutedDeps {
  onCloseConfirmed: (ourPosition: string) => Promise<void>;
  onCloseExecuted: (ev: { pool: string; positionPubkey?: string; commandId?: string }) => Promise<void>;
  hasPendingReshapeAdd: (commandId: string) => boolean;
  publishReshapeAddAfterBuy: (commandId: string) => Promise<void>;
  publishTwoSidedOpenAfterBuy: (commandId: string) => Promise<void>;
  hasPendingToken2022Deposit: (commandId: string) => boolean;
  publishDepositAfterPositionCreated: (commandId: string) => Promise<void>;
  onOpenConfirmed: (ourPosition: string) => void;
  hasPendingToken2022Mirror: (commandId: string) => boolean;
  finalizeToken2022Open: (commandId: string) => Promise<void>;
  onAddConfirmed: (ourPosition: string, commandId: string) => void;
  onClaimConfirmed: (ourPosition: string, commandId: string) => void;
  onSellConfirmed: (ev: ExecutedEvent) => void;
}

/** Route ONE `ev:executed` payload to its handler. Rejects iff the routed handler rejects (the caller's
 *  per-message try/catch turns that into a non-ack + retry). Branch order/conditions are identical to the
 *  original inline loop — do NOT reorder (a Token-2022 create/deposit 'open'/'add' must be caught by its
 *  pending-map branch BEFORE the classic-confirm branch). */
export async function dispatchExecuted(ev: ExecutedEvent | null, deps: DispatchExecutedDeps): Promise<void> {
  if (ev?.kind === 'close' && ev.pool) {
    if (ev.positionPubkey) await deps.onCloseConfirmed(ev.positionPubkey); // prompt DB markClosed — no 30s wait
    await deps.onCloseExecuted({ pool: ev.pool, positionPubkey: ev.positionPubkey, commandId: ev.commandId });
  } else if (ev?.kind === 'buy' && ev.commandId) {
    // a token BUY just landed → build+publish the OPEN (open buy) or the RESHAPE ADD (reshape buy).
    if (deps.hasPendingReshapeAdd(ev.commandId)) await deps.publishReshapeAddAfterBuy(ev.commandId);
    else await deps.publishTwoSidedOpenAfterBuy(ev.commandId);
  } else if (ev?.kind === 'open' && ev.commandId && deps.hasPendingToken2022Deposit(ev.commandId)) {
    // a Token-2022 / split open's empty position (TX1) CONFIRMED → build+publish the deposit (TX2).
    await deps.publishDepositAfterPositionCreated(ev.commandId);
  } else if (ev?.kind === 'open' && ev.positionPubkey && !(ev.commandId !== undefined && deps.hasPendingToken2022Deposit(ev.commandId))) {
    // a CLASSIC 1-tx open LANDED → FEED `lifecycle.open_confirmed`. Observability-only.
    deps.onOpenConfirmed(ev.positionPubkey);
  } else if (ev?.kind === 'add' && ev.commandId && deps.hasPendingToken2022Mirror(ev.commandId)) {
    // a Token-2022 open's deposit (TX2) landed → persist the mirror.
    await deps.finalizeToken2022Open(ev.commandId);
  } else if (ev?.kind === 'add' && ev.positionPubkey && ev.commandId) {
    // a CLASSIC reshape ADD leg LANDED → FEED `lifecycle.add_confirmed`. Observability-only.
    deps.onAddConfirmed(ev.positionPubkey, ev.commandId);
  } else if (ev?.kind === 'claim' && ev.positionPubkey && ev.commandId) {
    // a fees CLAIM LANDED → FEED `lifecycle.claim_confirmed`. Observability-only.
    deps.onClaimConfirmed(ev.positionPubkey, ev.commandId);
  } else if (ev?.kind === 'sell') {
    // a residual token→SOL SELL LANDED → FEED `swap.executed`. Observability-only.
    deps.onSellConfirmed(ev);
  }
}

/** A consumed bus message (id + authenticated payload, or null if the MAC/hop mismatched). */
export interface ExecutedMessage {
  id: string;
  payload: unknown | null;
}

/** The batch deps = the dispatch handlers + the ack and loop-error sinks (I/O, injected). */
export interface ExecutedBatchDeps extends DispatchExecutedDeps {
  ack: (id: string) => Promise<void>;
  /** Record a per-message loop error (system.loop_errored). The message is deliberately left UNACKED for retry. */
  onLoopError: (err: unknown, id: string) => void;
}

/** Process a batch of `ev:executed` messages with PER-MESSAGE error isolation (mirrors the coffre `processBatch`):
 *  on success ack; on throw record the loop error for THAT message and CONTINUE without acking (so the next PEL
 *  drain re-delivers it). One bad message must never strand its batch-mates nor abort the batch. */
export async function processExecutedBatch(msgs: ReadonlyArray<ExecutedMessage>, deps: ExecutedBatchDeps): Promise<void> {
  for (const msg of msgs) {
    try {
      await dispatchExecuted(msg.payload as ExecutedEvent | null, deps);
      await deps.ack(msg.id);
    } catch (err) {
      // A handler (e.g. a DB blip in onCloseConfirmed) or the ack itself threw → do NOT ack, do NOT abort the
      // batch. The next consumePending drain re-delivers this message for an idempotent retry.
      deps.onLoopError(err, msg.id);
    }
  }
}

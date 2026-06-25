/**
 * Copy-bot · P3/Inc.1 — typed bus contract (= a simplified `@repo/intent`, single-user). The brain publishes a
 * `SignRequest` on `cmd:sign`; the coffre re-validates it (strict Zod) then "intent-binds" it against the
 * decoded tx (Wall B). `.strict()` = rejection of any unexpected field (anti-injection).
 */
import { z } from 'zod';

export const SignRequestSchema = z
  .object({
    /** = derive(eventKey); the coffre's idempotency key (executions table). */
    commandId: z.string().min(1),
    /** leader:pool:event:slot:txSig — the originating leader event. */
    eventKey: z.string().min(1),
    kind: z.enum(['open', 'close', 'claim', 'sell', 'add', 'remove', 'buy']),
    pool: z.string().min(1),
    /** pubkey of OUR position (ephemeral for an open). For a 'sell', the position we just closed (provenance). */
    positionPubkey: z.string().min(1),
    /** our owner (copy-test); the coffre checks destination == owner. */
    owner: z.string().min(1),
    /** UNSIGNED DLMM tx, base64-serialized. */
    txBase64: z.string().min(1),
    /** SOL size we deploy (re-clamped by the coffre against the local config). */
    sizeSol: z.number().nonnegative(),
    /** re-anchored bin range — Wall B checks that the tx only touches this range. */
    targetBinRange: z.object({ lower: z.number().int(), upper: z.number().int() }),
    /** freshness bounds (anti-replay): the coffre requires currentSlot ≤ deadlineSlot. */
    issuedAtSlot: z.number().int().nonnegative(),
    deadlineSlot: z.number().int().nonnegative(),
    /** wall-clock ms of publication (bus→coffre latency measurement, speed pillar). */
    issuedAtMs: z.number().int().nonnegative(),
    /** present ONLY for a 'sell': the residual token→SOL swap parameters (Jupiter). bigints are strings. */
    sell: z
      .object({
        inputMint: z.string().min(1), // residual token being sold (Wall B binds the swap to owner's ATA of it)
        inputAmountRaw: z.string().min(1), // residual amount, raw token units
        minOutLamports: z.string().min(1), // slippage floor in lamports (traceability/telemetry)
      })
      .optional(),
    /** present ONLY for a 'buy': the SOL→token pre-swap that funds a two-sided copy's token leg (Jupiter, ExactOut). */
    buy: z
      .object({
        outputMint: z.string().min(1), // token being bought (Wall B binds the swap to owner's ATA of it)
        exactOutAmountRaw: z.string().min(1), // EXACT token amount to receive, raw token units
        maxInLamports: z.string().min(1), // SOL spend cap (slippage-bounded; Wall B re-clamps against the local cap)
      })
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // kind 'sell' ⟺ the sell payload is present (no ambiguous half-formed sell intents).
    if (v.kind === 'sell' && !v.sell) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sell payload required for kind=sell', path: ['sell'] });
    if (v.kind !== 'sell' && v.sell) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'sell payload only allowed for kind=sell', path: ['sell'] });
    // kind 'buy' ⟺ the buy payload is present (symmetric to sell).
    if (v.kind === 'buy' && !v.buy) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'buy payload required for kind=buy', path: ['buy'] });
    if (v.kind !== 'buy' && v.buy) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'buy payload only allowed for kind=buy', path: ['buy'] });
  });

export type SignRequest = z.infer<typeof SignRequestSchema>;

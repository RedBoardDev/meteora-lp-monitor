/**
 * Copy-bot · observability — emit input helper types (PURE).
 *
 * Keeps `codes.ts` / `event.ts` free of the "what may a call site pass" concern. The fields a producer supplies
 * are the `CopyEvent` shape MINUS the parts the emitter assembles itself (the identity `code`, the registry-
 * denormalized facets, the stamped `ts`, and the bound tenancy `ctx`). The pure assembler and the I/O emitter
 * (P1) consume `EmitInput`; nothing here performs I/O.
 */
import type { CopyEvent } from './event';
import type { CopyCode } from './codes';

/** The facets the emitter denormalizes from `CODE_REGISTRY[code]` — a call site never sets them. */
type RegistryDerived = 'code' | 'severity' | 'category' | 'audience' | 'pinned';

/** The fields the I/O emitter stamps/binds — a call site never sets them. */
type EmitterStamped = 'ts' | 'ctx' | 'userMessage';

/**
 * What a producer passes to `emit(code, input)`. `code` is the first argument (not part of the input bag), so the
 * generic `<C>` exists only to keep the call ergonomic and future-proof (per-code field narrowing can be layered
 * on later without changing call sites).
 */
export type EmitInput<_C extends CopyCode = CopyCode> = Omit<CopyEvent, RegistryDerived | EmitterStamped | 'eventTs'> & {
  /**
   * Defaults to `ts` (stamped by the emitter) when the producer does not observe a distinct business time. It is
   * `Omit`ted above before being re-added optional — otherwise the required `eventTs` on `CopyEvent` would survive
   * the intersection and force every call site to supply it, contradicting this "defaults to ts" contract.
   */
  eventTs?: number;
};

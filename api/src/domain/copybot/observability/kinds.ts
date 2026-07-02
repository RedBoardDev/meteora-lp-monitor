/**
 * Copy-bot · observability — the shared leaf enums (PURE, LEAF: no imports from `codes.ts`/`event.ts`).
 *
 * These three closed unions are the discriminant facets denormalized onto every `CopyEvent` and declared on
 * every `CodeMeta`. They live in a leaf module so the registry (`codes.ts`) and the record (`event.ts`) can both
 * depend on them without importing each other (breaks the sole `codes ↔ event` import cycle). Type-only.
 */

/** Severity for admin log level + UI coloring + alerting. Unchanged 3-value enum (mirrors `JournalSeverity`). */
export type CopySeverity = 'info' | 'warn' | 'error';

/** The 14 event namespaces (SPEC §1). One category per registry namespace. */
export type CopyCategory =
  | 'LIFECYCLE'
  | 'DETECT'
  | 'FILTER'
  | 'CAP'
  | 'SIZING'
  | 'BALANCE'
  | 'ELIGIBILITY'
  | 'RESHAPE'
  | 'SWAP'
  | 'SIGN'
  | 'WALLB'
  | 'FAILSAFE'
  | 'SWEEP'
  | 'SYSTEM';

/** Who sees the event. `'feed'` = visible to the user (the persisted `audience='feed'` rows ARE the feed). */
export type CopyAudience = 'internal' | 'feed';

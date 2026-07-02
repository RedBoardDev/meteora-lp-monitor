/**
 * Cross-process log MARKERS that double as a test contract. The on-chain harness measures the bot's reaction
 * latency and gates the no-miss killer tests by `.includes()`-grepping these exact free-text strings out of the
 * brain/coffre log files. A harmless reword at a producer site would silently break that measurement (latency
 * returns null) and the gates — so the strings live here as shared consts referenced by BOTH the producers and
 * the harness. The runtime text is byte-identical; only the source references are shared.
 *
 * NOTE: journal-derived markers (e.g. `SIGN landed`, built from the journal stage/outcome enum and locked by
 * journal.test.ts) are intentionally NOT here — they are already pinned by that test, not free text.
 */

/** Brain: a detected leader event was routed (start of the bot's controllable reaction latency). */
export const LOG_MARKER_EVENT_ROUTED = '👁️ event routed';

/** Coffre: the copy tx is ON THE WIRE (end of the controllable latency; on-chain confirm is separate). */
export const LOG_MARKER_SUBMITTED = '🚀 submitted';

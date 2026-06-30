/**
 * Copy-bot · observability — user-feed renderer (PURE: no I/O, no SDK, no DB).
 *
 * `toUserMessage(e)` builds the structured, i18n-ready `UserMessage` for a feed-visible event — or `null` when
 * the event is `audience:'internal'` (it never reaches the user). Emoji are fine here. SOL-ONLY: never USD,
 * never a derived/fake amount (SPEC §0 D-2, §3.2). Identical live and on replay.
 *
 * Two honest labels enforced by the SPEC:
 *  - D-2: the `balance.insufficient` SOL line shows the CONFIGURED value, labelled "configured" — NEVER claimed
 *    as the live wallet balance (no live read is wired yet).
 *  - D-6: close / add / swap feed messages show the INTENDED SOL size, labelled — realized deltas come later
 *    (the `ev:executed` bus extension is deferred).
 */
import { CODE_REGISTRY } from './codes';
import type { CopyEvent, UserMessage } from './event';

// ── Render constants (no magic literals) ────────────────────────────────────────────────────────────────────

/** SOL decimal places shown in the feed — enough precision for sub-SOL sizes without noise. */
const SOL_DECIMALS = 2;
/** Mint-truncation length when no token symbol is known: `${mint.slice(0,4)}/SOL` (SPEC §3.2 `pairLabel`). */
const MINT_TRUNCATE = 4;
/** Signature-truncation for the `tx: …` link label. */
const SIG_TRUNCATE = 6;

const EMOJI = {
  open: '🟢',
  close: '🔴',
  partialRemove: '🟠',
  add: '🟢',
  skippedAdd: '⏭️',
  claim: '💰',
  swap: '💱',
  insufficient: '⚠️',
  skipped: '🚫',
  noCopy: '🚫',
  failsafe: '🛟',
  alert: '🚨',
} as const;

// ── Link bases (admin payload carries the URLs; these are fallbacks for SOL-only ergonomics) ────────────────
const SOLSCAN_TX_BASE = 'https://solscan.io/tx/';
const JUP_SWAP_BASE = 'https://jup.ag/swap/';

/**
 * `pairLabel(e) = ${nonSolSymbol ?? truncate(mint,4)}/SOL` (SPEC §3.2). Pure. Falls back to the truncated mint
 * when the non-SOL token symbol is unknown, and to a literal placeholder when neither is present.
 */
export function pairLabel(e: CopyEvent): string {
  const symbol = readString(e.adminDetail, 'nonSolSymbol');
  if (symbol) return `${symbol}/SOL`;
  const mint = readString(e.adminDetail, 'mint');
  if (mint) return `${mint.slice(0, MINT_TRUNCATE)}/SOL`;
  return '?/SOL';
}

/**
 * Project a `CopyEvent` into a user-feed `UserMessage`, or `null` for internal codes. The template is selected by
 * `CODE_REGISTRY[code].render`; titles come from the registry so the feed and the admin codes never drift.
 */
export function toUserMessage(e: CopyEvent): UserMessage | null {
  const meta = CODE_REGISTRY[e.code];
  if (meta.audience === 'internal') return null;

  const pair = pairLabel(e);
  const links = e.signature ? [txLink(e.signature)] : [];

  switch (meta.render) {
    case 'open': {
      // 🟢 Opened DLMM Position — WIF/SOL · target 12.00 SOL → your 0.85 SOL · open 3
      const parts = [pair];
      if (e.leaderSizeSol !== undefined) parts.push(`target ${sol(e.leaderSizeSol)}`);
      if (e.ourSizeSol !== undefined) parts.push(`your ${sol(e.ourSizeSol)}`);
      const openCount = readNumber(e.adminDetail, 'openCount');
      if (openCount !== undefined) parts.push(`open ${openCount}`);
      return msg(EMOJI.open, e, parts, links);
    }
    case 'close': {
      // 🔴 Closed DLMM Position — WIF/SOL · size 0.85 SOL (intended) · tx: …   (D-6 intended, labelled)
      const parts = [pair];
      if (e.ourSizeSol !== undefined) parts.push(`size ${sol(e.ourSizeSol)} (intended)`);
      return msg(EMOJI.close, e, parts, links);
    }
    case 'partial-remove': {
      // 🟠 Partially Removed — WIF/SOL (−35%)
      const pct = readNumber(e.adminDetail, 'removedPct');
      const parts = [pct !== undefined ? `${pair} (−${pct}%)` : pair];
      return msg(EMOJI.partialRemove, e, parts, links);
    }
    case 'add': {
      // 🟢 Added Liquidity — WIF/SOL · 0.40 SOL (intended)   (D-6 intended, labelled)
      // ⏭️ Skipped Add — infinite-add off  (the cap.infinite_add_skipped variant)
      if (e.code === 'cap.infinite_add_skipped') {
        return msg(EMOJI.skippedAdd, e, [pair, 'infinite-add off'], links);
      }
      const parts = [pair];
      if (e.ourSizeSol !== undefined) parts.push(`${sol(e.ourSizeSol)} (intended)`);
      if (readBoolean(e.adminDetail, 'firstAdd')) parts.push('first add');
      return msg(EMOJI.add, e, parts, links);
    }
    case 'claim': {
      // 💰 Claimed Fees — WIF/SOL · tx: …
      return msg(EMOJI.claim, e, [pair], links);
    }
    case 'swap': {
      // 💱 Swapped 124,500 WIF → 0.31 SOL (intended) · tx: …   (D-6 intended, labelled)
      const inAmount = readNumber(e.adminDetail, 'swapInAmount');
      const inSymbol = readString(e.adminDetail, 'nonSolSymbol') ?? readString(e.adminDetail, 'mint')?.slice(0, MINT_TRUNCATE) ?? '?';
      const lhs = inAmount !== undefined ? `${formatTokenAmount(inAmount)} ${inSymbol}` : inSymbol;
      const rhs = e.ourSizeSol !== undefined ? `${sol(e.ourSizeSol)} (intended)` : 'SOL';
      return msg(EMOJI.swap, e, [`${lhs} → ${rhs}`], links);
    }
    case 'swap-failed': {
      // 🚨 Swap failed after retries — swap manually · jup.ag/swap/WIF-SOL
      const symbol = readString(e.adminDetail, 'nonSolSymbol');
      const jupLinks = symbol ? [{ label: 'swap manually', url: `${JUP_SWAP_BASE}${symbol}-SOL` }] : [];
      return msg(EMOJI.alert, e, [pair, 'swap failed — swap manually'], jupLinks);
    }
    case 'insufficient-balance': {
      // ⚠️ Insufficient balance — WIF/SOL · configured 0.42 / required 0.85 SOL — skipped  (D-2: CONFIGURED, labelled)
      const configured = readNumber(e.adminDetail, 'configuredSol');
      const required = readNumber(e.adminDetail, 'requiredSol') ?? e.ourSizeSol;
      const parts = [pair];
      if (configured !== undefined && required !== undefined) parts.push(`configured ${solBare(configured)} / required ${sol(required)} — skipped`);
      else if (required !== undefined) parts.push(`required ${sol(required)} — skipped`);
      else parts.push('skipped');
      return msg(EMOJI.insufficient, e, parts, links);
    }
    case 'skipped-filter': {
      // 🚫 Skipped — WIF/SOL · filter: <reason> (transparency)
      return msg(EMOJI.skipped, e, [pair, `filter: ${reasonText(e)}`], links);
    }
    case 'skipped-cap': {
      // 🚫 No copy — WIF/SOL · cap: <reason>
      return msg(EMOJI.noCopy, e, [pair, `cap: ${reasonText(e)}`], links);
    }
    case 'skipped-sizing': {
      // 🚫 Skipped — WIF/SOL · <reason>
      return msg(EMOJI.skipped, e, [pair, reasonText(e)], links);
    }
    case 'skipped-eligibility': {
      // 🚫 Skipped — WIF/SOL · <reason>
      return msg(EMOJI.skipped, e, [pair, reasonText(e)], links);
    }
    case 'failsafe-activated': {
      // 🛟 Failsafe Activated — WIF/SOL · leader closed, we auto-closed yours · tx: …
      return msg(EMOJI.failsafe, e, [pair, reasonText(e)], links);
    }
    case 'failsafe-failed': {
      // 🚨 Failsafe FAILED — close manually — WIF/SOL · app.meteora.ag/dlmm/…
      const meteoraUrl = readString(e.adminDetail, 'meteoraUrl');
      const failLinks = meteoraUrl ? [...links, { label: 'close manually', url: meteoraUrl }] : links;
      return msg(EMOJI.alert, e, [pair, 'close manually'], failLinks);
    }
    case 'system-fatal': {
      // 🚨 Bot Stopped — Fatal Error · <reason>
      return msg(EMOJI.alert, e, [reasonText(e)], links);
    }
    default:
      // A feed code with no `render` is a registry bug caught by codes.test.ts §2.2 test 3; render the title only.
      return msg(EMOJI.alert, e, [pair], links);
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────────────────────────────────────

/** Assemble the `UserMessage`. `titleKey` = the code (a future locale layer keys on it); the title text is the registry's. */
function msg(emoji: string, e: CopyEvent, lineParts: Array<string>, links: UserMessage['links']): UserMessage {
  return { emoji, titleKey: e.code, lineParts, links };
}

/** Format a SOL amount with its unit, e.g. `0.85 SOL`. */
function sol(v: number): string {
  return `${solBare(v)} SOL`;
}

/** Format a SOL amount WITHOUT the unit (used when several amounts share one trailing `SOL`), e.g. `0.42`. */
function solBare(v: number): string {
  return v.toFixed(SOL_DECIMALS);
}

/** Group a token amount with thousands separators (English locale), e.g. `124,500`. */
function formatTokenAmount(v: number): string {
  return v.toLocaleString('en-US');
}

/** A `tx: <sig…>` solscan link from a signature (SOL-only ergonomics; the admin row keeps the full sig). */
function txLink(signature: string): { label: string; url: string } {
  const shortSig = signature.length > SIG_TRUNCATE * 2 ? `${signature.slice(0, SIG_TRUNCATE)}…${signature.slice(-SIG_TRUNCATE)}` : signature;
  return { label: `tx: ${shortSig}`, url: `${SOLSCAN_TX_BASE}${signature}` };
}

/** The human reason text shown to the user — the verbatim leaf reason (identifier, not prose) or the registry title. */
function reasonText(e: CopyEvent): string {
  return e.reason ?? CODE_REGISTRY[e.code].title ?? e.code;
}

function readString(detail: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = detail?.[key];
  return typeof v === 'string' ? v : undefined;
}

function readNumber(detail: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = detail?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function readBoolean(detail: Record<string, unknown> | undefined, key: string): boolean {
  return detail?.[key] === true;
}

/**
 * Copy-bot · bus HMAC key guard (fail-closed on the money path).
 *
 * The coffre is the SOLE key holder and its only transport authentication is the bus HMAC (envelope.ts MACs
 * `${hop}\n${body}`). Shipping with the PUBLIC dev default means anyone who can reach Redis can forge `cmd:sign`
 * and get the vault to sign. So both processes MUST refuse to boot unless a real, non-default, long-enough key is
 * set — UNLESS an explicit local-dev escape (COPYBOT_DEV_BUS_KEY=true) is present. Pure + unit-tested; the callers
 * do the log + process.exit so the boot pattern stays identical to the other missing-env checks.
 */

/** The PUBLIC placeholder shipped in the repo — never a real secret; only accepted via the explicit dev escape. */
export const DEV_DEFAULT_BUS_KEY = 'dev-k-sign-CHANGE-ME';
/** Minimum bytes for a usable HMAC key — no shorter secret is worth accepting on the signing path. */
export const MIN_BUS_KEY_LENGTH = 16;

export type BusKeyResult = { key: string } | { error: string };

/**
 * Resolve the bus HMAC key fail-closed:
 *  - BUS_HMAC_KEY set, not the dev default, and ≥ MIN_BUS_KEY_LENGTH → OK, use it.
 *  - else COPYBOT_DEV_BUS_KEY === 'true' → explicit local-dev escape, allow the public default.
 *  - else → error (missing / insecure key).
 */
export function assertBusKey(env: { BUS_HMAC_KEY?: string; COPYBOT_DEV_BUS_KEY?: string }): BusKeyResult {
  const key = env.BUS_HMAC_KEY;
  if (key !== undefined && key !== DEV_DEFAULT_BUS_KEY && key.length >= MIN_BUS_KEY_LENGTH) {
    return { key };
  }
  if (env.COPYBOT_DEV_BUS_KEY === 'true') {
    return { key: DEV_DEFAULT_BUS_KEY };
  }
  return { error: 'BUS_HMAC_KEY missing or insecure — set it, or COPYBOT_DEV_BUS_KEY=true for local dev' };
}

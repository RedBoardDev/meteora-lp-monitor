/**
 * Copy-bot · Inc.1 — bus HMAC envelope (PURE, node:crypto). The bus (Redis) is an UNTRUSTED transport:
 * integrity comes ONLY from the HMAC over the EXACT body bytes, never from Redis. The `hop` is bound into
 * the MAC (domain separation) → an envelope from one hop cannot be replayed on another. We verify the MAC
 * BEFORE `JSON.parse` (never parse an unauthenticated payload).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Envelope {
  /** the serialized JSON payload — the EXACT bytes the MAC covers. */
  body: string;
  /** hex HMAC-SHA256 of `${hop}\n${body}` with the hop key. */
  hmac: string;
}

const mac = (hop: string, key: string, body: string): string =>
  createHmac('sha256', key).update(`${hop}\n${body}`).digest('hex');

/** Serialize + sign a payload for a given hop. */
export function encodeEnvelope(hop: string, key: string, payload: unknown): Envelope {
  const body = JSON.stringify(payload);
  return { body, hmac: mac(hop, key, body) };
}

/**
 * Verify the MAC (exact bytes + hop) in constant time, then parse. Returns the parsed object, or `null` if the
 * MAC does not match (tampering, wrong hop, wrong key) — in that case we DO NOT parse.
 */
export function verifyEnvelope(hop: string, key: string, env: Envelope): unknown | null {
  const expected = mac(hop, key, env.body);
  const got = Buffer.from(env.hmac, 'hex');
  const exp = Buffer.from(expected, 'hex');
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return null;
  return JSON.parse(env.body);
}

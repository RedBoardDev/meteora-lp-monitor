import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';

/**
 * Minimal, dependency-light auth: an account is identified by its Solana wallet address (proven once by
 * a wallet signature at registration) and protected by a password thereafter. The password is exchanged
 * for a signed HS256 JWT — the session credential (no static API token). Every comparison is
 * constant-time; the token-signing key is the explicit AUTH_SECRET (required at boot) and stable across
 * restarts. Wallet ownership is proven via ed25519 (tweetnacl) over a SIWS-style message.
 */

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
  /** Per-user token generation; a reset bumps the user's version, invalidating older tokens. */
  ver: number;
  /** Session id — the auth hook accepts the token only while this jti is still an active session. */
  jti: string;
}

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — long-lived for a personal self-hosted tool
const b64url = (b: Buffer): string => b.toString('base64url');
const hmac = (secret: string, data: string): Buffer =>
  createHmac('sha256', secret).update(data).digest();

export function createJwt(
  secret: string,
  sub: string,
  ver: number,
  jti: string,
  ttlSeconds = TOKEN_TTL_SECONDS,
): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    Buffer.from(JSON.stringify({ sub, iat: now, exp: now + ttlSeconds, ver, jti })),
  );
  const sig = b64url(hmac(secret, `${header}.${payload}`));
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(secret: string, token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts as [string, string, string];
  const expected = b64url(hmac(secret, `${header}.${payload}`));
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as JwtPayload;
    if (typeof data.exp !== 'number' || data.exp < Math.floor(Date.now() / 1000)) return null;
    // Normalise ver/jti so callers can treat them as plain values (tokens always carry them now).
    if (typeof data.ver !== 'number') data.ver = 0;
    if (typeof data.jti !== 'string') data.jti = '';
    return data;
  } catch {
    return null;
  }
}

/** Hash a password with scrypt + a random salt. Stored as `scrypt$<saltHex>$<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time verify against a stored scrypt hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] as string, 'hex');
  const expected = Buffer.from(parts[2] as string, 'hex');
  if (expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length);
  return timingSafeEqual(actual, expected);
}

/** True iff `address` is a syntactically valid Solana address (base58 that decodes to 32 bytes). */
export function isValidSolanaAddress(address: unknown): address is string {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) return false;
  try {
    return new PublicKey(address).toBytes().length === 32;
  } catch {
    return false;
  }
}

/**
 * The SIWS-style challenge the wallet signs to prove ownership of `address`. It binds the signature to
 * THIS app (domain + uri) and to a single-use server `nonce`, so it can be replayed neither here nor on
 * another site. Deterministic: the server reconstructs the exact same string at verify time. It is a
 * MESSAGE, never a transaction — signing authorizes nothing on-chain and costs no gas.
 */
export function buildSiwsMessage(p: {
  domain: string;
  uri: string;
  address: string;
  nonce: string;
}): string {
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.address,
    '',
    'Prove you own this wallet to create your Meteora LP Monitor account.',
    'This is a signature only — it authorizes nothing on-chain and costs no gas.',
    '',
    `URI: ${p.uri}`,
    'Version: 1',
    `Nonce: ${p.nonce}`,
  ].join('\n');
}

/**
 * Strict ed25519 verification that `signatureBase64` is a signature of `message` by the private key of
 * `address`. The public key is the claimed address itself (Solana addresses ARE ed25519 public keys).
 * Any malformed input (bad address, wrong-length signature, decode error) returns false.
 */
export function verifyWalletSignature(
  message: string,
  signatureBase64: string,
  address: string,
): boolean {
  try {
    const pubkey = new PublicKey(address).toBytes();
    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length !== 64) return false;
    return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pubkey);
  } catch {
    return false;
  }
}

export { TOKEN_TTL_SECONDS };

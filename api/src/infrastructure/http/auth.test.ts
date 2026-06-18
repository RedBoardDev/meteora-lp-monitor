import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import {
  buildSiwsMessage,
  createJwt,
  isValidSolanaAddress,
  verifyJwt,
  verifyWalletSignature,
} from './auth';

const secret = 'test-secret-key';

describe('auth — JWT (versioned + session id, no static token)', () => {
  it('signs and verifies a JWT round-trip (carrying the version + session id)', () => {
    const p = verifyJwt(secret, createJwt(secret, 'u1', 3, 'sess-1', 60));
    expect(p?.sub).toBe('u1');
    expect(p?.ver).toBe(3);
    expect(p?.jti).toBe('sess-1');
    expect(p ? p.exp > p.iat : false).toBe(true);
  });

  it('rejects a token signed with a different secret', () => {
    expect(verifyJwt('other-secret', createJwt(secret, 'u1', 0, 'sess-1', 60))).toBeNull();
  });

  it('rejects a tampered payload (forged claims)', () => {
    const [h, , s] = createJwt(secret, 'u1', 0, 'sess-1', 60).split('.') as [
      string,
      string,
      string,
    ];
    const forged = Buffer.from(
      JSON.stringify({ sub: 'admin', iat: 1, exp: 9_999_999_999, ver: 0, jti: 'x' }),
    ).toString('base64url');
    expect(verifyJwt(secret, `${h}.${forged}.${s}`)).toBeNull();
  });

  it('rejects an expired token', () => {
    expect(verifyJwt(secret, createJwt(secret, 'u1', 0, 'sess-1', -1))).toBeNull();
  });
});

describe('auth — wallet ownership (SIWS-style)', () => {
  it('validates real Solana addresses and rejects malformed ones', () => {
    const real = Keypair.generate().publicKey.toBase58();
    expect(isValidSolanaAddress(real)).toBe(true);
    expect(isValidSolanaAddress('not-an-address')).toBe(false);
    expect(isValidSolanaAddress('0OIl')).toBe(false); // contains base58-excluded chars + too short
    expect(isValidSolanaAddress('')).toBe(false);
    expect(isValidSolanaAddress(null)).toBe(false);
    expect(isValidSolanaAddress(123)).toBe(false);
  });

  it('builds a deterministic challenge bound to domain + address + nonce', () => {
    const m1 = buildSiwsMessage({
      domain: 'app.tld',
      uri: 'https://app.tld',
      address: 'A',
      nonce: 'N',
    });
    const m2 = buildSiwsMessage({
      domain: 'app.tld',
      uri: 'https://app.tld',
      address: 'A',
      nonce: 'N',
    });
    expect(m1).toBe(m2); // reconstructable at verify time
    expect(m1).toContain('app.tld');
    expect(m1).toContain('Nonce: N');
    expect(m1).toContain('A');
  });

  it('verifies a genuine signature and rejects tampering / wrong signer', () => {
    const kp = Keypair.generate();
    const address = kp.publicKey.toBase58();
    const message = buildSiwsMessage({
      domain: 'app.tld',
      uri: 'https://app.tld',
      address,
      nonce: 'nonce-123',
    });
    const sig = Buffer.from(
      nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
    ).toString('base64');

    expect(verifyWalletSignature(message, sig, address)).toBe(true);
    // Wrong message (the nonce/domain binding is what stops replay).
    expect(verifyWalletSignature(`${message} tampered`, sig, address)).toBe(false);
    // Right message + signature but a DIFFERENT claimed signer.
    expect(verifyWalletSignature(message, sig, Keypair.generate().publicKey.toBase58())).toBe(
      false,
    );
    // Garbage signature.
    expect(verifyWalletSignature(message, 'not-base64-sig!!', address)).toBe(false);
  });
});

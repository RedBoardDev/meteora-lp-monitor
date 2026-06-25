import { describe, expect, it } from 'vitest';
import { encodeEnvelope, verifyEnvelope } from './envelope';

const HOP = 'cmd:sign';
const KEY = 'k_sign_secret';
const payload = { commandId: 'c1', kind: 'open', n: 42 };

describe('envelope HMAC — bus integrity', () => {
  it('round-trip: encode then verify (same hop+key) → the payload', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(verifyEnvelope(HOP, KEY, env)).toEqual(payload);
  });

  it('tampered body → null (we do NOT parse an unauthenticated payload)', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    const tampered = { ...env, body: env.body.replace('42', '999') };
    expect(verifyEnvelope(HOP, KEY, tampered)).toBeNull();
  });

  it('wrong hop → null (domain separation: no cross-hop replay)', () => {
    const env = encodeEnvelope('cmd:execute', KEY, payload);
    expect(verifyEnvelope('cmd:sign', KEY, env)).toBeNull();
  });

  it('wrong key → null', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(verifyEnvelope(HOP, 'autre_cle', env)).toBeNull();
  });

  it('tampered hmac of different length → null (no throw)', () => {
    const env = encodeEnvelope(HOP, KEY, payload);
    expect(verifyEnvelope(HOP, KEY, { ...env, hmac: 'deadbeef' })).toBeNull();
  });
});

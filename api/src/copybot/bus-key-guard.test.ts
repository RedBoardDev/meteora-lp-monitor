import { describe, expect, it } from 'vitest';
import { assertBusKey, DEV_DEFAULT_BUS_KEY, MIN_BUS_KEY_LENGTH } from './bus-key-guard';

// The bus HMAC is the coffre's ONLY transport auth (the vault is the sole key holder). A silent fallback to the
// public dev default = anyone with Redis access can forge cmd:sign. So the guard MUST fail-closed: boot only with a
// real, non-default, long-enough key, unless the operator explicitly opts into the dev default on this machine.
describe('assertBusKey — fail-closed bus HMAC key resolution (money path)', () => {
  it('accepts a real key (non-default, ≥ min length) and returns it verbatim', () => {
    const key = 'a'.repeat(MIN_BUS_KEY_LENGTH);
    expect(assertBusKey({ BUS_HMAC_KEY: key })).toEqual({ key });
  });

  it('errors when BUS_HMAC_KEY is unset (no silent fallback to the public default)', () => {
    const r = assertBusKey({});
    expect('error' in r).toBe(true);
  });

  it('errors when BUS_HMAC_KEY equals the public dev default and no escape is set', () => {
    const r = assertBusKey({ BUS_HMAC_KEY: DEV_DEFAULT_BUS_KEY });
    expect('error' in r).toBe(true);
  });

  it('allows the dev default ONLY with the explicit COPYBOT_DEV_BUS_KEY=true escape', () => {
    expect(assertBusKey({ COPYBOT_DEV_BUS_KEY: 'true' })).toEqual({ key: DEV_DEFAULT_BUS_KEY });
    // escape also covers an unset BUS_HMAC_KEY (local dev with no key configured at all)
    expect(assertBusKey({ BUS_HMAC_KEY: DEV_DEFAULT_BUS_KEY, COPYBOT_DEV_BUS_KEY: 'true' })).toEqual({ key: DEV_DEFAULT_BUS_KEY });
  });

  it('errors on a too-short key (below the min length) without the escape', () => {
    const r = assertBusKey({ BUS_HMAC_KEY: 'a'.repeat(MIN_BUS_KEY_LENGTH - 1) });
    expect('error' in r).toBe(true);
  });
});

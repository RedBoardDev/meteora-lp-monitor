import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveCommandId } from './command-id';

// deriveCommandId is the idempotency key (executions INSERT ON CONFLICT before signing) AND the ephemeral-position
// seed; the VAULT re-derives it and requires commandId == deriveCommandId(eventKey). So the test pins the EXACT
// algorithm (a drift would make the vault reject every command), determinism (same event never double-signs), and
// distinctness (different events never collide into one idempotency slot → a missed copy).
describe('deriveCommandId — idempotency key (brain↔vault contract)', () => {
  it('is exactly sha256(eventKey) in lowercase hex — the byte-for-byte contract the vault re-derives', () => {
    const eventKey = 'LEADER:POOL:open:SIG123';
    expect(deriveCommandId(eventKey)).toBe(createHash('sha256').update(eventKey).digest('hex'));
    // a fixed published vector — guards against a silent algorithm/encoding change:
    expect(deriveCommandId('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('is DETERMINISTIC — the same eventKey always yields the same id (idempotency: no double-sign on a retry)', () => {
    const eventKey = 'LEADER:5rCf:close:abcdef';
    expect(deriveCommandId(eventKey)).toBe(deriveCommandId(eventKey));
  });

  it('is DISTINCT across different eventKeys (distinct events never collide into one idempotency slot)', () => {
    const open = deriveCommandId('LEADER:POOL:open:SIG');
    const close = deriveCommandId('LEADER:POOL:close:SIG'); // same sig, different kind
    const otherSig = deriveCommandId('LEADER:POOL:open:SIG2');
    expect(open).not.toBe(close);
    expect(open).not.toBe(otherSig);
  });

  it('always returns 64 lowercase hex chars (a valid sha256 digest)', () => {
    expect(deriveCommandId('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

/**
 * Copy-bot · Inc.2/3 — deterministic `commandId` = sha256(eventKey). PURE, shared brain↔vault (web3-free).
 * Acts as the idempotency key (`executions` table, INSERT ON CONFLICT before signing) AND as the seed of the
 * ephemeral position (see `ephemeral-position.ts`). The vault re-derives it and requires `commandId == deriveCommandId(eventKey)`.
 */
import { createHash } from 'node:crypto';

export function deriveCommandId(eventKey: string): string {
  return createHash('sha256').update(eventKey).digest('hex');
}

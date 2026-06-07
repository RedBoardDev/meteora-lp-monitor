import type { ClosedPosition } from '@meteora/shared';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { SqlitePositionRepository } from './position-repository';

const base: Omit<ClosedPosition, 'positionAddress' | 'pnlSol' | 'pnlSource'> = {
  wallet: 'w',
  poolAddress: 'p',
  tokenX: 'MEME',
  tokenY: 'SOL',
  tokenXMint: 'mint',
  pnlPctSol: 0,
  feesSol: 0,
  depositSol: 10,
  withdrawSol: 9,
  openedAt: 1,
  closedAt: 2,
  durationSeconds: 1,
};
const read = (repo: SqlitePositionRepository) =>
  repo.getClosed('w', { page: 1, pageSize: 10 }).rows[0]!;

describe('SqlitePositionRepository — closed PnL', () => {
  it('keeps the market reprice (residual @ market) when a later pool-price resync re-upserts', () => {
    const repo = new SqlitePositionRepository(openDatabase(':memory:'));
    repo.upsertClosed([{ ...base, positionAddress: 'A', pnlSol: -0.19, pnlSource: 'market' }]);
    expect(read(repo).pnlSol).toBeCloseTo(-0.19);
    repo.upsertClosed([{ ...base, positionAddress: 'A', pnlSol: -0.01, pnlSource: 'pool' }]);
    expect(read(repo).pnlSol).toBeCloseTo(-0.19); // market value survives the pool-mark resync
    expect(read(repo).pnlSource).toBe('market');
  });

  it('falls back to the pool mark when never repriced', () => {
    const repo = new SqlitePositionRepository(openDatabase(':memory:'));
    repo.upsertClosed([{ ...base, positionAddress: 'B', pnlSol: -0.028, pnlSource: 'pool' }]);
    expect(read(repo).pnlSol).toBeCloseTo(-0.028);
    expect(read(repo).pnlSource).toBe('pool');
  });

  it('derives pnlPctSol in percent points (not a fraction) so colour thresholds read it', () => {
    const repo = new SqlitePositionRepository(openDatabase(':memory:'));
    // +0.0946 SOL on a 5 SOL deposit = +1.89%, which must clear a 0.5% green threshold.
    repo.upsertClosed([
      { ...base, positionAddress: 'E', depositSol: 5, pnlSol: 0.0946, pnlSource: 'pool' },
    ]);
    expect(read(repo).pnlPctSol).toBeCloseTo(1.892, 2);
  });

  it('setAuthoritativePnl (LPAgent) overrides even after freeze, and survives a later resync', () => {
    const repo = new SqlitePositionRepository(openDatabase(':memory:'));
    const closedAt = Date.now() - 300_000; // past the settle/freeze window
    repo.upsertClosed([
      { ...base, positionAddress: 'F', closedAt, pnlSol: -0.01, pnlSource: 'pool' },
    ]);
    repo.setAuthoritativePnl('F', -0.19174); // LPAgent's market-valued PnL
    expect(read(repo).pnlSol).toBeCloseTo(-0.19174);
    // The 90s pool-price resync must not clobber the LPAgent value.
    repo.upsertClosed([
      { ...base, positionAddress: 'F', closedAt, pnlSol: -0.02, pnlSource: 'pool' },
    ]);
    expect(read(repo).pnlSol).toBeCloseTo(-0.19174);
  });
});

describe('SqlitePositionRepository — close PnL freeze', () => {
  it('still refines the figures while the close is settling (within the window)', () => {
    const repo = new SqlitePositionRepository(openDatabase(':memory:'));
    const closedAt = Date.now(); // just closed — Meteora indexer may still be settling
    // Provisional capture right after close (the inflated value that wrongly alerted the user).
    repo.upsertClosed([
      { ...base, positionAddress: 'C', closedAt, pnlSol: 0.06, pnlSource: 'pool' },
    ]);
    // A resync moments later carries the settled figure — must overwrite while still in-window.
    repo.upsertClosed([
      { ...base, positionAddress: 'C', closedAt, pnlSol: -0.0146, pnlSource: 'pool' },
    ]);
    expect(read(repo).pnlSol).toBeCloseTo(-0.0146);
  });

  it('freezes the figures once the close has settled — a later resync cannot drift them', () => {
    const repo = new SqlitePositionRepository(openDatabase(':memory:'));
    const closedAt = Date.now() - 200_000; // closed well beyond the settle window
    repo.upsertClosed([
      { ...base, positionAddress: 'D', closedAt, pnlSol: -0.0146, pnlSource: 'pool' },
    ]);
    // The periodic resync re-marks an already-settled close — this must be ignored.
    repo.upsertClosed([
      { ...base, positionAddress: 'D', closedAt, pnlSol: 0.06, feesSol: 0.06, pnlSource: 'pool' },
    ]);
    expect(read(repo).pnlSol).toBeCloseTo(-0.0146);
    expect(read(repo).feesSol).toBeCloseTo(0);
  });
});

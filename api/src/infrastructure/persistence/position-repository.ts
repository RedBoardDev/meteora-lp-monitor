import type { ClosedPosition, OpenPosition, RangeStatus } from '@meteora/shared';
import type { PoolRef, PositionRepository } from '@/domain/ports';
import type { Db } from './database';

// A close stays mutable for this long after closed_at so the Meteora indexer can settle the
// withdrawal/fees figures; after that the financials are frozen and the periodic resync no
// longer re-marks them. Must stay LARGER than the engine's CLOSE_SETTLE_MS (which fires the
// notification): the notification is sent on a value still inside this window, so what the user
// is told matches the figure that ultimately freezes.
const SETTLE_MS = 150_000;

/** SQLite-backed position store. All writes are idempotent upserts by primary key. */
export class SqlitePositionRepository implements PositionRepository {
  constructor(private readonly db: Db) {}

  upsertOpen(positions: OpenPosition[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO positions (position_address, wallet, pool_address, token_x, token_y, token_x_mint, status,
        pnl_sol, pnl_pct_sol, size_sol, claimed_fees_sol, unclaimed_fees_sol,
        min_price, max_price, pool_price, range_status, oor_since, opened_at, updated_at)
      VALUES (@positionAddress, @wallet, @poolAddress, @tokenX, @tokenY, @tokenXMint, 'open',
        @pnlSol, @pnlPctSol, @sizeSol, @claimedFeesSol, @unclaimedFeesSol,
        @minPrice, @maxPrice, @poolPrice, @rangeStatus, @outOfRangeSince, @openedAt, @updatedAt)
      ON CONFLICT(position_address) DO UPDATE SET
        status='open', token_x_mint=@tokenXMint, pnl_sol=@pnlSol, pnl_pct_sol=@pnlPctSol,
        size_sol=@sizeSol, claimed_fees_sol=@claimedFeesSol, unclaimed_fees_sol=@unclaimedFeesSol,
        min_price=@minPrice, max_price=@maxPrice, pool_price=@poolPrice,
        range_status=@rangeStatus, oor_since=@outOfRangeSince, updated_at=@updatedAt
    `);
    const tx = this.db.transaction((rows: OpenPosition[]) => {
      // Explicit binding — OpenPosition carries transient fields (hold*) that aren't columns;
      // better-sqlite3 rejects unknown named params.
      for (const p of rows)
        stmt.run({
          positionAddress: p.positionAddress,
          wallet: p.wallet,
          poolAddress: p.poolAddress,
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          tokenXMint: p.tokenXMint,
          pnlSol: p.pnlSol,
          pnlPctSol: p.pnlPctSol,
          sizeSol: p.sizeSol,
          claimedFeesSol: p.claimedFeesSol,
          unclaimedFeesSol: p.unclaimedFeesSol,
          minPrice: p.minPrice,
          maxPrice: p.maxPrice,
          poolPrice: p.poolPrice,
          rangeStatus: p.rangeStatus,
          outOfRangeSince: p.outOfRangeSince,
          openedAt: p.openedAt,
          updatedAt: p.updatedAt,
        });
    });
    tx(positions);
  }

  upsertClosed(positions: ClosedPosition[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO positions (position_address, wallet, pool_address, token_x, token_y, token_x_mint, status,
        pnl_sol, pnl_pct_sol, deposit_sol, withdraw_sol, claimed_fees_sol,
        opened_at, closed_at, duration_seconds, market_pnl_sol, updated_at)
      VALUES (@positionAddress, @wallet, @poolAddress, @tokenX, @tokenY, @tokenXMint, 'closed',
        @pnlSol, @pnlPctSol, @depositSol, @withdrawSol, @feesSol,
        @openedAt, @closedAt, @durationSeconds, @marketPnlSol, @updatedAt)
      ON CONFLICT(position_address) DO UPDATE SET
        status='closed', token_x_mint=@tokenXMint, pnl_sol=@pnlSol, pnl_pct_sol=@pnlPctSol,
        deposit_sol=@depositSol, withdraw_sol=@withdrawSol, claimed_fees_sol=@feesSol,
        closed_at=@closedAt, duration_seconds=@durationSeconds, updated_at=@updatedAt,
        -- keep an existing market reprice; the periodic pool-price resync passes null here.
        market_pnl_sol=COALESCE(@marketPnlSol, positions.market_pnl_sol)
      -- Freeze the realized figures once the close has settled: allow the first close write
      -- (status still 'open'/'pending_close') and any re-mark within SETTLE_MS of closed_at,
      -- then lock — so the periodic resync can no longer drift an already-reported PnL.
      WHERE positions.status != 'closed'
         OR @updatedAt - COALESCE(positions.closed_at, 0) < @settleMs
    `);
    const now = Date.now();
    const tx = this.db.transaction((rows: ClosedPosition[]) => {
      // Explicit binding object — ClosedPosition carries transient fields (residual*) that
      // aren't columns; better-sqlite3 rejects unknown named params.
      for (const p of rows)
        stmt.run({
          positionAddress: p.positionAddress,
          wallet: p.wallet,
          poolAddress: p.poolAddress,
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          tokenXMint: p.tokenXMint,
          pnlSol: p.pnlSol,
          pnlPctSol: p.pnlPctSol,
          depositSol: p.depositSol,
          withdrawSol: p.withdrawSol,
          feesSol: p.feesSol,
          openedAt: p.openedAt,
          closedAt: p.closedAt,
          durationSeconds: p.durationSeconds,
          marketPnlSol: p.pnlSource === 'market' ? p.pnlSol : null,
          updatedAt: now,
          settleMs: SETTLE_MS,
        });
    });
    tx(positions);
  }

  replaceOpenForWallet(wallet: string, positions: OpenPosition[]): void {
    const newAddrs = new Set(positions.map((p) => p.positionAddress));
    const tx = this.db.transaction(() => {
      this.upsertOpen(positions);
      // Positions previously open for this wallet but no longer present:
      // mark for reconciliation (status stays until the close is confirmed & fetched).
      const stale = this.db
        .prepare(`SELECT position_address FROM positions WHERE wallet=? AND status='open'`)
        .all(wallet) as { position_address: string }[];
      const drop = this.db.prepare(
        `UPDATE positions SET status='pending_close', updated_at=? WHERE position_address=?`,
      );
      const now = Date.now();
      for (const row of stale) {
        if (!newAddrs.has(row.position_address)) drop.run(now, row.position_address);
      }
    });
    tx();
  }

  getOpen(wallet: string): OpenPosition[] {
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE wallet=? AND status='open' ORDER BY pnl_sol DESC`)
      .all(wallet) as Record<string, unknown>[];
    return rows.map(rowToOpen);
  }

  getClosed(wallet: string, opts: { page: number; pageSize: number }) {
    const where = wallet === 'all' ? `status='closed'` : `wallet=? AND status='closed'`;
    const args = wallet === 'all' ? [] : [wallet];
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS c FROM positions WHERE ${where}`).get(...args) as {
        c: number;
      }
    ).c;
    const offset = (opts.page - 1) * opts.pageSize;
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE ${where} ORDER BY closed_at DESC LIMIT ? OFFSET ?`)
      .all(...args, opts.pageSize, offset) as Record<string, unknown>[];
    return { rows: rows.map(rowToClosed), total };
  }

  pendingClosePools(wallet: string): PoolRef[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT pool_address, token_x, token_y, token_x_mint FROM positions
         WHERE wallet=? AND status='pending_close'`,
      )
      .all(wallet) as Record<string, unknown>[];
    return rows.map((r) => ({
      poolAddress: String(r.pool_address),
      tokenX: String(r.token_x ?? '?'),
      tokenY: String(r.token_y ?? 'SOL'),
      tokenXMint: String(r.token_x_mint ?? ''),
      tokenYMint: '', // not stored; residual reprice for X/SOL pools uses tokenXMint anyway
    }));
  }

  closedAddresses(): string[] {
    const rows = this.db
      .prepare(`SELECT position_address FROM positions WHERE status='closed'`)
      .all() as { position_address: string }[];
    return rows.map((r) => r.position_address);
  }

  setAuthoritativePnl(positionAddress: string, pnlSol: number): void {
    this.db
      .prepare(`UPDATE positions SET market_pnl_sol=? WHERE position_address=? AND status='closed'`)
      .run(pnlSol, positionAddress);
  }

  getClosedForStats(scope: string): ClosedPosition[] {
    const where = scope === 'all' ? `status='closed'` : `wallet=? AND status='closed'`;
    const args = scope === 'all' ? [] : [scope];
    const rows = this.db
      .prepare(`SELECT * FROM positions WHERE ${where} ORDER BY closed_at ASC`)
      .all(...args) as Record<string, unknown>[];
    return rows.map(rowToClosed);
  }

  getSyncState(wallet: string) {
    const row = this.db
      .prepare(`SELECT last_full_sync_at, last_closed_ts FROM sync_state WHERE wallet=?`)
      .get(wallet) as
      | { last_full_sync_at: number | null; last_closed_ts: number | null }
      | undefined;
    return {
      lastFullSyncAt: row?.last_full_sync_at ?? null,
      lastClosedTs: row?.last_closed_ts ?? null,
    };
  }

  setSyncState(wallet: string, state: { lastFullSyncAt: number; lastClosedTs: number }): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (wallet, last_full_sync_at, last_closed_ts)
         VALUES (?, ?, ?)
         ON CONFLICT(wallet) DO UPDATE SET last_full_sync_at=excluded.last_full_sync_at,
           last_closed_ts=excluded.last_closed_ts`,
      )
      .run(wallet, state.lastFullSyncAt, state.lastClosedTs);
  }
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);

function rowToOpen(r: Record<string, unknown>): OpenPosition {
  return {
    positionAddress: String(r.position_address),
    wallet: String(r.wallet),
    poolAddress: String(r.pool_address),
    tokenX: String(r.token_x),
    tokenY: String(r.token_y),
    tokenXMint: String(r.token_x_mint ?? ''),
    sizeSol: n(r.size_sol),
    pnlSol: n(r.pnl_sol),
    pnlPctSol: n(r.pnl_pct_sol),
    claimedFeesSol: n(r.claimed_fees_sol),
    unclaimedFeesSol: n(r.unclaimed_fees_sol),
    rangeStatus: (r.range_status as RangeStatus) ?? 'unknown',
    minPrice: n(r.min_price),
    maxPrice: n(r.max_price),
    poolPrice: r.pool_price == null ? null : n(r.pool_price),
    outOfRangeSince: r.oor_since == null ? null : n(r.oor_since),
    openedAt: r.opened_at == null ? null : n(r.opened_at),
    updatedAt: n(r.updated_at),
  };
}

function rowToClosed(r: Record<string, unknown>): ClosedPosition {
  // Effective PnL = LPAgent's market-valued PnL when enriched (stored in market_pnl_sol),
  // else Meteora's raw pool mark as the fallback until LPAgent's value arrives.
  const market = r.market_pnl_sol == null ? null : n(r.market_pnl_sol);
  const pnlSol = market ?? n(r.pnl_sol);
  const depositSol = n(r.deposit_sol);
  return {
    positionAddress: String(r.position_address),
    wallet: String(r.wallet),
    poolAddress: String(r.pool_address),
    tokenX: String(r.token_x),
    tokenY: String(r.token_y),
    tokenXMint: String(r.token_x_mint ?? ''),
    pnlSol,
    // Percent points (e.g. 1.89 == +1.89%) — same unit as Meteora's pnlSolPctChange and the open
    // side, so the UI's percent formatting and colour thresholds read it correctly.
    pnlPctSol: depositSol > 0 ? (pnlSol / depositSol) * 100 : n(r.pnl_pct_sol),
    feesSol: n(r.claimed_fees_sol),
    depositSol,
    withdrawSol: n(r.withdraw_sol),
    openedAt: r.opened_at == null ? null : n(r.opened_at),
    closedAt: r.closed_at == null ? null : n(r.closed_at),
    durationSeconds: r.duration_seconds == null ? null : n(r.duration_seconds),
    pnlSource: market != null ? 'market' : 'pool',
  };
}

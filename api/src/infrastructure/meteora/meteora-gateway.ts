import { type ClosedPosition, METEORA_API_BASE, type OpenPosition } from '@meteora/shared';
import type { Logger } from 'pino';
import type { PoolRef, PositionsGateway } from '@/domain/ports';
import { resolveRangeStatus } from '@/domain/position';

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Meteora DLMM REST gateway. Every list endpoint paginates fully (the legacy tool's
 * #1 bug was reading only page 1 → missing positions). PnL is Meteora's `pnlSol`
 * (mark-to-market at the pool price, validated == on-chain to <0.001 SOL).
 */
export class MeteoraGateway implements PositionsGateway {
  constructor(
    private readonly logger: Logger,
    private readonly base: string = METEORA_API_BASE,
  ) {}

  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Meteora ${res.status} ${url}`);
    return (await res.json()) as T;
  }

  async listOpenPools(wallet: string): Promise<PoolRef[]> {
    return this.listPools(`${this.base}/portfolio/open`, wallet);
  }

  async listClosedPools(wallet: string, daysBack: number): Promise<PoolRef[]> {
    return this.listPools(`${this.base}/portfolio`, wallet, `&days_back=${daysBack}`);
  }

  private async listPools(endpoint: string, wallet: string, extra = ''): Promise<PoolRef[]> {
    const out: PoolRef[] = [];
    for (let page = 1; page <= 100; page++) {
      const url = `${endpoint}?user=${wallet}&page=${page}&page_size=100${extra}`;
      const json = await this.getJson<{ pools?: unknown[]; hasNext?: boolean }>(url);
      const pools = (json.pools ?? []) as Array<Record<string, unknown>>;
      for (const p of pools) {
        out.push({
          poolAddress: String(p.poolAddress),
          tokenX: (p.tokenX as string) || '?',
          tokenY: (p.tokenY as string) || 'SOL',
          tokenXMint: String(p.tokenXMint ?? ''),
          tokenYMint: String(p.tokenYMint ?? ''),
        });
      }
      if (!json.hasNext || pools.length === 0) break;
    }
    return out;
  }

  async fetchOpenPositions(wallet: string, pool: PoolRef): Promise<OpenPosition[]> {
    return this.fetchPositions(wallet, pool, 'open', (p) => this.mapOpen(wallet, pool, p));
  }

  async fetchClosedPositions(wallet: string, pool: PoolRef): Promise<ClosedPosition[]> {
    return this.fetchPositions(wallet, pool, 'closed', (p) => this.mapClosed(wallet, pool, p));
  }

  private async fetchPositions<T>(
    wallet: string,
    pool: PoolRef,
    status: 'open' | 'closed',
    map: (p: Record<string, unknown>) => T,
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const url = `${this.base}/positions/${pool.poolAddress}/pnl?user=${wallet}&status=${status}&page=${page}&page_size=100`;
      let json: { positions?: unknown[]; hasNext?: boolean };
      try {
        json = await this.getJson(url);
      } catch (err) {
        this.logger.warn({ err, pool: pool.poolAddress, status }, 'fetchPositions page failed');
        break;
      }
      const positions = (json.positions ?? []) as Array<Record<string, unknown>>;
      for (const p of positions) out.push(map(p));
      if (!json.hasNext || positions.length === 0) break;
    }
    return out;
  }

  private mapOpen(wallet: string, pool: PoolRef, p: Record<string, unknown>): OpenPosition {
    const u = (p.unrealizedPnl ?? {}) as Record<string, Record<string, unknown>>;
    const unclaimed = num(u.unclaimedFeeTokenX?.amountSol) + num(u.unclaimedFeeTokenY?.amountSol);
    const minPrice = num(p.minPrice);
    const maxPrice = num(p.maxPrice);
    const poolPrice = p.poolActivePrice != null ? num(p.poolActivePrice) : null;
    const createdAt = p.createdAt != null ? num(p.createdAt) * 1000 : null;
    // Non-SOL token currently held (balanceTokenX/Y, confirmed from the live payload) — to revalue
    // at the market price in the engine. amount==0 means the position is fully on the SOL side.
    const yIsSol = (pool.tokenY || '').toUpperCase() === 'SOL';
    const hold = (yIsSol ? u.balanceTokenX : u.balanceTokenY) as Record<string, unknown> | undefined;
    const holdAmount = num(hold?.amount);
    return {
      positionAddress: String(p.positionAddress),
      wallet,
      poolAddress: pool.poolAddress,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
      tokenXMint: pool.tokenXMint,
      sizeSol: num((u.balancesSol as unknown) ?? 0),
      pnlSol: num(p.pnlSol),
      pnlPctSol: num(p.pnlSolPctChange),
      claimedFeesSol: num((p.allTimeFees as Record<string, Record<string, unknown>>)?.total?.sol),
      unclaimedFeesSol: unclaimed,
      rangeStatus: resolveRangeStatus(poolPrice, minPrice, maxPrice),
      minPrice,
      maxPrice,
      poolPrice,
      outOfRangeSince: null, // stateful — owned by the engine
      openedAt: createdAt,
      updatedAt: 0, // stamped by the engine (avoids Date in pure-ish gateway)
      holdMint: yIsSol ? pool.tokenXMint : pool.tokenYMint,
      holdAmount,
      holdMarkSol: num(hold?.amountSol),
    };
  }

  private mapClosed(wallet: string, pool: PoolRef, p: Record<string, unknown>): ClosedPosition {
    const fees = (p.allTimeFees as Record<string, Record<string, unknown>>)?.total?.sol;
    const dep = (p.allTimeDeposits as Record<string, Record<string, unknown>>)?.total?.sol;
    const withdrawals = p.allTimeWithdrawals as Record<string, Record<string, unknown>> | undefined;
    const wd = withdrawals?.total?.sol;
    // Residual = the non-SOL side left at close (what the user must still sell). Its close
    // value is the only price-sensitive part of PnL — the engine may revalue it at market.
    const yIsSol = (pool.tokenY || '').toUpperCase() === 'SOL';
    const residualSide = yIsSol ? withdrawals?.tokenX : withdrawals?.tokenY;
    const residualMint = yIsSol ? pool.tokenXMint : pool.tokenYMint;
    const createdAt = p.createdAt != null ? num(p.createdAt) * 1000 : null;
    const closedAt = p.closedAt != null ? num(p.closedAt) * 1000 : null;
    const duration =
      createdAt != null && closedAt != null ? Math.round((closedAt - createdAt) / 1000) : null;
    return {
      positionAddress: String(p.positionAddress),
      wallet,
      poolAddress: pool.poolAddress,
      tokenX: pool.tokenX,
      tokenY: pool.tokenY,
      tokenXMint: pool.tokenXMint,
      pnlSol: num(p.pnlSol),
      pnlPctSol: num(p.pnlSolPctChange),
      feesSol: num(fees),
      depositSol: num(dep),
      withdrawSol: num(wd),
      openedAt: createdAt,
      closedAt,
      durationSeconds: duration,
      residualMint,
      residualAmount: num(residualSide?.amount),
      residualMarkSol: num(residualSide?.amountSol),
      pnlSource: 'pool',
    };
  }
}

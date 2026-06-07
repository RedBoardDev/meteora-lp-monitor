import {
  JUPITER_PRICE_API,
  SOL_MINT,
  TOKEN_PROGRAM_ID,
  USDC_MINT,
  USDT_MINT,
} from '@meteora/shared';
import type { Logger } from 'pino';
import type { BalanceGateway } from '@/domain/ports';

const LAMPORTS_PER_SOL = 1_000_000_000;

interface ParsedTokenAccount {
  account?: {
    data?: { parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number | null } } } };
  };
}

const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Idle wallet capital in SOL = native SOL + wSOL (1:1) + USDC/USDT converted via Jupiter.
 * Two single RPC calls (some providers 403 on batched array bodies) + one Jupiter price
 * call only when stables are present. Cheap enough for a 30s cadence; the long tail of
 * dust/scam tokens is intentionally ignored.
 */
export class RpcBalanceGateway implements BalanceGateway {
  constructor(
    private readonly httpUrl: string,
    private readonly logger: Logger,
  ) {}

  async getIdleSol(wallet: string): Promise<number> {
    try {
      const [balance, tokens] = await Promise.all([
        this.rpc<{ value?: number }>('getBalance', [wallet]),
        this.rpc<{ value?: ParsedTokenAccount[] }>('getTokenAccountsByOwner', [
          wallet,
          { programId: TOKEN_PROGRAM_ID },
          { encoding: 'jsonParsed' },
        ]),
      ]);
      const native = num(balance?.value) / LAMPORTS_PER_SOL;
      const accounts = tokens?.value ?? [];

      let wsol = 0;
      let usdc = 0;
      let usdt = 0;
      for (const a of accounts) {
        const info = a.account?.data?.parsed?.info;
        const amt = num(info?.tokenAmount?.uiAmount);
        if (amt <= 0) continue;
        if (info?.mint === SOL_MINT) wsol += amt;
        else if (info?.mint === USDC_MINT) usdc += amt;
        else if (info?.mint === USDT_MINT) usdt += amt;
      }

      const stableSol = usdc + usdt > 0 ? await this.stablesToSol(usdc, usdt) : 0;
      return native + wsol + stableSol;
    } catch (err) {
      this.logger.warn({ err, wallet }, 'idle balance fetch failed — treating as 0');
      return 0;
    }
  }

  private async stablesToSol(usdc: number, usdt: number): Promise<number> {
    try {
      const res = await fetch(`${JUPITER_PRICE_API}?ids=${SOL_MINT},${USDC_MINT},${USDT_MINT}`);
      if (!res.ok) throw new Error(`Jupiter ${res.status}`);
      const prices = (await res.json()) as Record<string, { usdPrice?: number }>;
      const solUsd = num(prices[SOL_MINT]?.usdPrice);
      if (solUsd <= 0) return 0;
      const usd = usdc * num(prices[USDC_MINT]?.usdPrice) + usdt * num(prices[USDT_MINT]?.usdPrice);
      return usd / solUsd;
    } catch (err) {
      this.logger.warn({ err }, 'stablecoin price fetch failed — excluding stables');
      return 0;
    }
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T | undefined> {
    const res = await fetch(this.httpUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: '1', method, params }),
    });
    if (!res.ok) throw new Error(`RPC ${res.status} ${method}`);
    const json = (await res.json()) as { result?: T; error?: { message?: string } };
    if (json.error) throw new Error(`RPC ${method}: ${json.error.message ?? 'error'}`);
    return json.result;
  }
}

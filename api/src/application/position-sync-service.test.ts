import { type ClosedPosition, type OpenPosition, SOL_MINT } from '@meteora/shared';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { OnchainPositionValue, OnchainValued, OnchainWalletSnapshot } from '@/domain/dlmm';
import type { PositionPnl } from './dlmm-position-pnl';
import { type LegProjectionSource, PositionSync } from './position-sync-service';

const silent = pino({ level: 'silent' });

const proj = (over: Partial<PositionPnl>): PositionPnl => ({
  position: 'p',
  pool: 'pool',
  pnlSol: 0,
  depositSol: 1,
  withdrawSol: 0,
  claimedFeesSol: 0,
  legs: 1,
  tokenMint: 'MEMEmint',
  solDenominated: true,
  openedAt: 1000,
  closedAt: 2000,
  durationSeconds: 1,
  ...over,
});

const opv = (positionAddress: string): OnchainPositionValue => ({
  positionAddress,
  lbPair: 'lb',
  tokenXMint: 'MEMEmint',
  tokenYMint: SOL_MINT,
  amountX: 0n,
  amountY: 0n,
  feeX: 0n,
  feeY: 0n,
  decimalsX: 6,
  decimalsY: 9,
  activeId: 0,
  binStep: 100,
  lowerBinId: -10,
  upperBinId: 10,
  lamports: 0n,
});

const valued = (over: Partial<OnchainValued> = {}): OnchainValued => ({
  slot: 1,
  slotSkew: 0,
  tvlSol: 5,
  idleSol: 0,
  unclaimedFeesSol: 0.1,
  lockedRentSol: 0,
  walletTotalSol: 5.1,
  positionCount: 1,
  sizeSolByPosition: new Map([['OPEN', 5]]),
  feeSolByPosition: new Map([['OPEN', 0.1]]),
  ...over,
});

describe('PositionSync — chain → positions table', () => {
  it('routes a snapshot-present position to OPEN and an absent one to CLOSED, through the repo', async () => {
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({ position: 'OPEN', depositSol: 6 }),
        proj({
          position: 'CLOSED',
          pnlSol: 0.24,
          depositSol: 6,
          withdrawSol: 6.2,
          claimedFeesSol: 0.04,
        }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const metadata = {
      resolve: vi.fn(
        async (mints: string[]) =>
          new Map(mints.map((m) => [m, { symbol: m === SOL_MINT ? 'SOL' : 'MEME' }])),
      ),
    };
    const replaceOpenForWallet = vi.fn<(wallet: string, rows: OpenPosition[]) => Promise<void>>(
      async () => {},
    );
    const upsertClosed = vi.fn<(rows: ClosedPosition[]) => Promise<void>>(async () => {});
    const repo = {
      replaceOpenForWallet,
      upsertClosed,
      getOpen: vi.fn(async (): Promise<OpenPosition[]> => []),
      getStrategies: vi.fn(async () => new Map<string, never>()),
    };

    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [opv('OPEN')],
    };

    const sync = new PositionSync(legPnl, metadata, repo, silent);
    const res = await sync.sync('W', snapshot, valued());

    expect(res).toEqual({ open: 1, closed: 1 });

    expect(replaceOpenForWallet).toHaveBeenCalledTimes(1);
    const [openWallet, openRows] = replaceOpenForWallet.mock.calls[0]!;
    expect(openWallet).toBe('W');
    expect(openRows).toHaveLength(1);
    expect(openRows[0]!.positionAddress).toBe('OPEN');
    expect(openRows[0]!.tokenX).toBe('MEME');
    expect(openRows[0]!.tokenY).toBe('SOL');
    expect(openRows[0]!.sizeSol).toBe(5);
    expect(openRows[0]!.pnlSol).toBeCloseTo(5 + 0.1 - 6, 9); // live size + unclaimed − deposit

    expect(upsertClosed).toHaveBeenCalledTimes(1);
    const closedRows = upsertClosed.mock.calls[0]![0];
    expect(closedRows).toHaveLength(1);
    expect(closedRows[0]!.positionAddress).toBe('CLOSED');
    expect(closedRows[0]!.pnlSol).toBeCloseTo(0.24, 9);
  });

  it('preserves the prior out-of-range timestamp from the existing open rows', async () => {
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [proj({ position: 'OPEN', depositSol: 6 })]),
      pnlForPositions: vi.fn(async () => [proj({ position: 'OPEN', depositSol: 6 })]),
    };
    const metadata = {
      resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol: 'S' }]))),
    };
    const openRows: { positionAddress: string; rangeStatus?: string }[] = [];
    const repo = {
      replaceOpenForWallet: vi.fn(async (_w: string, rows: { positionAddress: string }[]) => {
        openRows.push(...rows);
      }),
      upsertClosed: vi.fn(async () => {}),
      getOpen: vi.fn(async () => [{ positionAddress: 'OPEN', outOfRangeSince: 1234 }]),
      getStrategies: vi.fn(async () => new Map()),
    };
    // active bin above range → out_up → OOR clock applies, must keep 1234 not reset to now
    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [{ ...opv('OPEN'), activeId: 50 }],
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    await new PositionSync(legPnl, metadata, repo as any, silent).sync('W', snapshot, valued());
    expect(openRows[0]).toMatchObject({ positionAddress: 'OPEN', outOfRangeSince: 1234 });
  });

  it('refreshOpen writes ONLY the open set (loads the open subset, never re-touches closed history)', async () => {
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => {
        throw new Error('refreshOpen must not load the full leg history');
      }),
      pnlForPositions: vi.fn(async () => [proj({ position: 'OPEN', depositSol: 6 })]),
    };
    const metadata = {
      resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol: 'S' }]))),
    };
    const replaceOpenForWallet = vi.fn(async () => {});
    const upsertClosed = vi.fn(async () => {});
    const repo = {
      replaceOpenForWallet,
      upsertClosed,
      getOpen: vi.fn(async () => []),
      getStrategies: vi.fn(async () => new Map<string, never>()),
    };
    const snapshot: OnchainWalletSnapshot = {
      owner: 'W',
      slot: 1,
      slotSkew: 0,
      nativeLamports: 0n,
      idleTokens: [],
      positions: [opv('OPEN')],
    };
    const count = await new PositionSync(
      legPnl,
      metadata,
      // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
      repo as any,
      silent,
    ).refreshOpen('W', snapshot, valued());
    expect(count).toBe(1);
    expect(legPnl.pnlForPositions).toHaveBeenCalledWith(['OPEN']); // only the open subset's legs
    expect(replaceOpenForWallet).toHaveBeenCalledTimes(1);
    expect(upsertClosed).not.toHaveBeenCalled(); // the cadence NEVER re-writes the closed history
  });
});

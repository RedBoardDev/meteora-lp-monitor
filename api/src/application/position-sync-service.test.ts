import { type ClosedPosition, type OpenPosition, SOL_MINT } from '@binsight/shared';
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
  complete: true,
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
      complete: true,
    };

    const sync = new PositionSync(legPnl, metadata, repo, silent);
    const res = await sync.sync('W', snapshot, valued());

    // No prior persisted open row for CLOSED (getOpen → []), so it's NOT a newly-closed transition:
    // closedRows is empty even though the closed COUNT is 1 (this is the backfill-safety property).
    expect(res.open).toBe(1);
    expect(res.closed).toBe(1);
    expect(res.closedRows).toEqual([]);
    // The open rows are returned so the engine can refresh its in-memory open set (the live /state).
    expect(res.openPositions).toHaveLength(1);
    expect(res.openPositions[0]!.positionAddress).toBe('OPEN');

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
      complete: true,
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
      complete: true,
    };
    const open = await new PositionSync(
      legPnl,
      metadata,
      // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
      repo as any,
      silent,
    ).refreshOpen('W', snapshot, valued());
    // refreshOpen returns the open rows so the engine can refresh its in-memory open set.
    expect(open).toHaveLength(1);
    expect(open[0]!.positionAddress).toBe('OPEN');
    expect(legPnl.pnlForPositions).toHaveBeenCalledWith(['OPEN']); // only the open subset's legs
    expect(replaceOpenForWallet).toHaveBeenCalledTimes(1);
    expect(upsertClosed).not.toHaveBeenCalled(); // the cadence NEVER re-writes the closed history
  });
});

/**
 * The close-notification wiring (PositionSync.sync.closedRows ⊕ the engine's `wasReconciled` gate).
 * This is the LIVE push-notification path: a backfill that spams or a duplicated close = notification spam.
 * We drive a stateful repo (the persisted open set evolves exactly as production does) and reproduce the
 * exact emit decision from engine/index.ts so the test fails the moment that decision regresses.
 */
describe('PositionSync — close-notification wiring (no backfill spam, no duplicates)', () => {
  const metadata = {
    resolve: vi.fn(async (m: string[]) => new Map(m.map((x) => [x, { symbol: 'S' }]))),
  };

  /** A repo whose persisted open set mutates through replaceOpenForWallet — like the real DB does. */
  const statefulRepo = (initialOpen: OpenPosition[]) => {
    let open = [...initialOpen];
    return {
      replaceOpenForWallet: vi.fn(async (_w: string, rows: OpenPosition[]) => {
        open = [...rows];
      }),
      upsertClosed: vi.fn(async () => {}),
      getOpen: vi.fn(async () => open),
      getStrategies: vi.fn(async () => new Map<string, never>()),
    };
  };

  const snap = (openAddrs: string[]): OnchainWalletSnapshot => ({
    owner: 'W',
    slot: 1,
    slotSkew: 0,
    nativeLamports: 0n,
    idleTokens: [],
    positions: openAddrs.map((a) => opv(a)),
    complete: true,
  });

  /** Mirror of the engine seam: capture reconciled state, sync, then emit one `closed` per newly-closed
   *  row ONLY if the wallet was already reconciled. Returns the emitted closed addresses for assertions. */
  const runSync = async (
    sync: PositionSync,
    snapshot: OnchainWalletSnapshot,
    wasReconciled: boolean,
  ): Promise<string[]> => {
    const res = await sync.sync('W', snapshot, valued());
    const emitted: string[] = [];
    if (wasReconciled) for (const row of res.closedRows) emitted.push(row.positionAddress);
    return emitted;
  };

  it('(a) the INITIAL backfill sync emits ZERO closed events even with a non-empty closed set', async () => {
    // Wallet onboarding: many historical closes land at once. Nothing was persisted as open before, and
    // wasReconciled is false → ZERO notifications. (Both guards independently prevent the 15k-row spam.)
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({ position: 'OPEN', depositSol: 6 }),
        proj({ position: 'HIST1', withdrawSol: 1 }),
        proj({ position: 'HIST2', withdrawSol: 1 }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const repo = statefulRepo([]); // nothing persisted yet — true first sync
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    const sync = new PositionSync(legPnl, metadata, repo as any, silent);

    const emitted = await runSync(sync, snap(['OPEN']), /* wasReconciled */ false);
    expect(emitted).toEqual([]); // no backfill spam
    // And even the raw closedRows are empty: no historical close was ever in the persisted open set.
    const res = await sync.sync('W', snap(['OPEN']), valued());
    expect(res.closed).toBe(2);
    expect(res.closedRows).toEqual([]);
  });

  it('(b)+(c) a position closing on a later live sync emits exactly ONE closed event, never again', async () => {
    // OPEN was reconciled earlier and is persisted as open. On the next sync the snapshot no longer lists
    // it → open→closed transition → exactly one `closed`. The sync AFTER that must NOT re-emit, because
    // sync 1 already dropped OPEN from the persisted open set (so it's no longer a transition).
    const legPnl: LegProjectionSource = {
      pnlByPosition: vi.fn(async () => [
        proj({
          position: 'OPEN',
          pnlSol: 0.5,
          depositSol: 6,
          withdrawSol: 6.5,
          claimedFeesSol: 0.04,
        }),
      ]),
      pnlForPositions: vi.fn(async () => []),
    };
    const repo = statefulRepo([
      // biome-ignore lint/suspicious/noExplicitAny: minimal persisted-open stub (only address/oor read)
      { positionAddress: 'OPEN', outOfRangeSince: null } as any,
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: partial repo stub for a focused unit test
    const sync = new PositionSync(legPnl, metadata, repo as any, silent);

    // Sync 1 — snapshot no longer contains OPEN → it closes. wasReconciled true → emit exactly one.
    const first = await sync.sync('W', snap([]), valued());
    expect(first.closedRows).toHaveLength(1); // (b) exactly one newly-closed row
    const payload = first.closedRows[0]!;
    // The emitted row is a real ClosedPosition carrying everything handleClosed reads.
    expect(payload).toMatchObject({
      wallet: 'W',
      positionAddress: 'OPEN',
      tokenX: 'S',
      tokenY: 'S',
    });
    expect(typeof payload.pnlSol).toBe('number');
    expect(typeof payload.feesSol).toBe('number');
    expect(await runSync(sync, snap([]), /* wasReconciled */ true)).toEqual([]); // already consumed above

    // Sync 2 — OPEN was dropped from the persisted open set by sync 1, so it's no longer a transition.
    const second = await sync.sync('W', snap([]), valued());
    expect(second.closedRows).toEqual([]); // (c) no duplicate, even when still wasReconciled === true
    expect(await runSync(sync, snap([]), /* wasReconciled */ true)).toEqual([]);
  });
});

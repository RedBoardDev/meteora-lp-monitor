import { describe, expect, it, vi } from 'vitest';
import { type ExecutedBatchDeps, type ExecutedMessage, dispatchExecuted, processExecutedBatch } from './dispatch-executed';

// A full set of stub handlers (all no-ops / not-pending by default); each test overrides what it asserts on.
function makeDeps(over: Partial<ExecutedBatchDeps> = {}): ExecutedBatchDeps {
  return {
    onCloseConfirmed: vi.fn(async () => {}),
    onCloseExecuted: vi.fn(async () => {}),
    hasPendingReshapeAdd: vi.fn(() => false),
    publishReshapeAddAfterBuy: vi.fn(async () => {}),
    publishTwoSidedOpenAfterBuy: vi.fn(async () => {}),
    hasPendingToken2022Deposit: vi.fn(() => false),
    publishDepositAfterPositionCreated: vi.fn(async () => {}),
    onOpenConfirmed: vi.fn(() => {}),
    hasPendingToken2022Mirror: vi.fn(() => false),
    finalizeToken2022Open: vi.fn(async () => {}),
    onAddConfirmed: vi.fn(() => {}),
    onClaimConfirmed: vi.fn(() => {}),
    onSellConfirmed: vi.fn(() => {}),
    ack: vi.fn(async () => {}),
    onLoopError: vi.fn(() => {}),
    ...over,
  };
}

describe('dispatchExecuted — routes each ev:executed kind to its handler', () => {
  it('close → onCloseConfirmed (prompt markClosed) THEN onCloseExecuted (residual sell)', async () => {
    // WHY: a landed close must both mark the DB closed AND trigger the residual sell — the fast path, not the 30s reconcile.
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'close', pool: 'P', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.onCloseConfirmed).toHaveBeenCalledWith('OUR');
    expect(deps.onCloseExecuted).toHaveBeenCalledWith({ pool: 'P', positionPubkey: 'OUR', commandId: 'C' });
  });

  it('buy with a pending reshape add → publishReshapeAddAfterBuy (not the open path)', async () => {
    const deps = makeDeps({ hasPendingReshapeAdd: vi.fn(() => true) });
    await dispatchExecuted({ kind: 'buy', commandId: 'C' }, deps);
    expect(deps.publishReshapeAddAfterBuy).toHaveBeenCalledWith('C');
    expect(deps.publishTwoSidedOpenAfterBuy).not.toHaveBeenCalled();
  });

  it('buy with NO pending reshape add → publishTwoSidedOpenAfterBuy', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'buy', commandId: 'C' }, deps);
    expect(deps.publishTwoSidedOpenAfterBuy).toHaveBeenCalledWith('C');
    expect(deps.publishReshapeAddAfterBuy).not.toHaveBeenCalled();
  });

  it('open with a pending Token-2022 deposit → publishDepositAfterPositionCreated (not the classic confirm)', async () => {
    const deps = makeDeps({ hasPendingToken2022Deposit: vi.fn(() => true) });
    await dispatchExecuted({ kind: 'open', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.publishDepositAfterPositionCreated).toHaveBeenCalledWith('C');
    expect(deps.onOpenConfirmed).not.toHaveBeenCalled();
  });

  it('classic open (no pending deposit) → onOpenConfirmed', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'open', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.onOpenConfirmed).toHaveBeenCalledWith('OUR');
    expect(deps.publishDepositAfterPositionCreated).not.toHaveBeenCalled();
  });

  it('add with a pending Token-2022 mirror → finalizeToken2022Open (not the reshape confirm)', async () => {
    const deps = makeDeps({ hasPendingToken2022Mirror: vi.fn(() => true) });
    await dispatchExecuted({ kind: 'add', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.finalizeToken2022Open).toHaveBeenCalledWith('C');
    expect(deps.onAddConfirmed).not.toHaveBeenCalled();
  });

  it('classic reshape add → onAddConfirmed', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'add', positionPubkey: 'OUR', commandId: 'C' }, deps);
    expect(deps.onAddConfirmed).toHaveBeenCalledWith('OUR', 'C');
    expect(deps.finalizeToken2022Open).not.toHaveBeenCalled();
  });

  it('claim → onClaimConfirmed; sell → onSellConfirmed', async () => {
    const deps = makeDeps();
    await dispatchExecuted({ kind: 'claim', positionPubkey: 'OUR', commandId: 'C' }, deps);
    await dispatchExecuted({ kind: 'sell', commandId: 'S', pool: 'P' }, deps);
    expect(deps.onClaimConfirmed).toHaveBeenCalledWith('OUR', 'C');
    expect(deps.onSellConfirmed).toHaveBeenCalledWith({ kind: 'sell', commandId: 'S', pool: 'P' });
  });

  it('null / unknown-kind payload → no handler called (defensive no-op)', async () => {
    const deps = makeDeps();
    await dispatchExecuted(null, deps);
    await dispatchExecuted({ kind: 'mystery' }, deps);
    expect(deps.onCloseConfirmed).not.toHaveBeenCalled();
    expect(deps.onSellConfirmed).not.toHaveBeenCalled();
  });

  it('re-delivered buy whose pending entry is gone → publish handler no-ops (idempotent replay)', async () => {
    // WHY: after a PEL-drain retry, the deferred-publish handler must be a clean no-op (delete-on-use map already
    // consumed) — dispatch still routes to it; the handler itself no-ops. Here we assert routing + no throw.
    const publishTwoSidedOpenAfterBuy = vi.fn(async () => {}); // real handler no-ops when the map entry is absent
    const deps = makeDeps({ publishTwoSidedOpenAfterBuy });
    await expect(dispatchExecuted({ kind: 'buy', commandId: 'ALREADY-DONE' }, deps)).resolves.toBeUndefined();
    expect(publishTwoSidedOpenAfterBuy).toHaveBeenCalledWith('ALREADY-DONE');
  });

  it('a throwing handler makes dispatch REJECT (so the batch guard can isolate it)', async () => {
    const boom = new Error('db blip in markClosed');
    const deps = makeDeps({ onCloseConfirmed: vi.fn(async () => { throw boom; }) });
    await expect(dispatchExecuted({ kind: 'close', pool: 'P', positionPubkey: 'OUR' }, deps)).rejects.toBe(boom);
  });
});

describe('processExecutedBatch — per-message isolation + non-ack-on-throw (no-miss)', () => {
  const msg = (id: string, payload: unknown): ExecutedMessage => ({ id, payload });

  it('one throwing message does NOT abort the batch: its mates are still processed AND acked', async () => {
    // WHY (the #8 bug): a throwing handler previously escaped the for-loop → the whole batch backed off and the
    // delivered messages were never acked → confirmations stranded in the PEL forever. Each message must be isolated.
    const onCloseConfirmed = vi.fn(async (our: string) => {
      if (our === 'BAD') throw new Error('db blip');
    });
    const deps = makeDeps({ onCloseConfirmed });
    const batch: ExecutedMessage[] = [
      msg('1', { kind: 'close', pool: 'P', positionPubkey: 'OK1' }),
      msg('2', { kind: 'close', pool: 'P', positionPubkey: 'BAD' }),
      msg('3', { kind: 'sell', commandId: 'S', pool: 'P' }),
    ];
    await processExecutedBatch(batch, deps);

    // The good close (1) and the sell (3) were fully handled and acked.
    expect(deps.onCloseConfirmed).toHaveBeenCalledWith('OK1');
    expect(deps.onSellConfirmed).toHaveBeenCalledTimes(1);
    expect(deps.ack).toHaveBeenCalledWith('1');
    expect(deps.ack).toHaveBeenCalledWith('3');
    // The throwing message (2) was recorded as a loop error and deliberately NOT acked → recovered by the next PEL drain.
    expect(deps.onLoopError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.onLoopError).mock.calls[0]?.[1]).toBe('2');
    expect(deps.ack).not.toHaveBeenCalledWith('2');
  });

  it('a failing ack is isolated to its own message (left unACKed) without aborting the batch', async () => {
    // WHY: an ack blip must not skip the rest of the batch nor mark the message done — the PEL drain retries it.
    const ack = vi.fn(async (id: string) => {
      if (id === '1') throw new Error('redis blip on ack');
    });
    const deps = makeDeps({ ack });
    await processExecutedBatch([msg('1', { kind: 'sell', commandId: 'S1' }), msg('2', { kind: 'sell', commandId: 'S2' })], deps);
    expect(deps.onSellConfirmed).toHaveBeenCalledTimes(2); // both dispatched
    expect(deps.onLoopError).toHaveBeenCalledTimes(1); // only msg 1's ack failed
    expect(deps.ack).toHaveBeenCalledWith('2');
  });

  it('a drained PEL message that is now a no-op is acked (idempotent recovery, not re-stranded)', async () => {
    // WHY: the PEL drain re-delivers a message that already succeeded; its handler no-ops and the batch acks it so
    // it leaves the PEL for good (no infinite redelivery).
    const deps = makeDeps(); // publishTwoSidedOpenAfterBuy is a no-op stub (map entry already consumed)
    await processExecutedBatch([msg('9', { kind: 'buy', commandId: 'DONE' })], deps);
    expect(deps.publishTwoSidedOpenAfterBuy).toHaveBeenCalledWith('DONE');
    expect(deps.ack).toHaveBeenCalledWith('9');
    expect(deps.onLoopError).not.toHaveBeenCalled();
  });

  it('empty batch → nothing happens (no ack, no error)', async () => {
    const deps = makeDeps();
    await processExecutedBatch([], deps);
    expect(deps.ack).not.toHaveBeenCalled();
    expect(deps.onLoopError).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { classifyInstruction } from '@/domain/dlmm';
import dlmmIdl from './dlmm/dlmm-idl.json';
import { parseInstruction } from './helius-subscriber';

const DLMM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const invoke = (n = 1) => `Program ${DLMM} invoke [${n}]`;
const success = () => `Program ${DLMM} success`;
const ix = (name: string) => `Program log: Instruction: ${name}`;

describe('parseInstruction (multi-instruction tx priority)', () => {
  // Real on-chain close tx (sig V1NEAGER…) carries three top-level DLMM instructions; the old code
  // returned the FIRST (RemoveLiquidityByRange2) and lost the ws:close fast-path.
  const closeLogs = [
    invoke(1),
    ix('RemoveLiquidityByRange2'),
    ix('TransferChecked'),
    invoke(2),
    success(),
    success(),
    invoke(1),
    ix('ClaimFee2'),
    invoke(2),
    success(),
    success(),
    invoke(1),
    ix('ClosePositionIfEmpty'),
    invoke(2),
    success(),
    success(),
  ];

  it('classifies a real close tx as close, not remove', () => {
    expect(classifyInstruction(parseInstruction(closeLogs) ?? '')).toBe('close');
  });

  it('a partial close (remove + transfer, no ClosePosition) stays remove', () => {
    const logs = [invoke(1), ix('RemoveLiquidityByRange2'), ix('TransferChecked'), success()];
    expect(classifyInstruction(parseInstruction(logs) ?? '')).toBe('remove');
  });

  it('an open tx (InitializePosition + AddLiquidityByStrategy2) classifies as open, not add', () => {
    const logs = [
      invoke(1),
      ix('InitializePosition'),
      success(),
      invoke(1),
      ix('AddLiquidityByStrategy2'),
      success(),
    ];
    expect(classifyInstruction(parseInstruction(logs) ?? '')).toBe('open');
  });

  it('returns null when the tx touches no DLMM instruction', () => {
    expect(parseInstruction(['Program log: Instruction: TransferChecked'])).toBeNull();
  });
});

describe('classifyInstruction', () => {
  it('maps the real PascalCase on-chain names', () => {
    expect(classifyInstruction('AddLiquidityByStrategy2')).toBe('add');
    expect(classifyInstruction('RemoveLiquidityByRange2')).toBe('remove');
    expect(classifyInstruction('ClaimFee2')).toBe('claim');
    expect(classifyInstruction('ClosePositionIfEmpty')).toBe('close');
    expect(classifyInstruction('InitializePosition')).toBe('open');
    expect(classifyInstruction('TransferChecked')).toBeNull();
  });

  // A full close withdraws via RemoveAllLiquidity; its normalized name (`removeallliquidity`) does not
  // start with `removeliquidity`, so it used to return null and a leader remove could be missed.
  it('classifies RemoveAllLiquidity (full-close withdraw) as remove', () => {
    expect(classifyInstruction('RemoveAllLiquidity')).toBe('remove');
  });
});

// Drift guard: the classifier only ever sees the Anchor instruction name from the on-chain log
// (`Program log: Instruction: <PascalCase>`), whose lowercase form equals the IDL snake_case name with
// underscores stripped. Simulate that transform over the REAL IDL so a new remove-liquidity variant
// (or a prefix that over-matches) fails here instead of silently dropping a leader event.
describe('classifyInstruction vs the real DLMM IDL instruction set', () => {
  const onchainName = (idlName: string) => idlName.replaceAll('_', '');
  const instructions = (dlmmIdl.instructions as { name: string }[]).map((i) => i.name);
  const isRemoveLiquidity = (name: string) => /remove.*liquidity/i.test(name);

  it('classifies every remove-liquidity IDL instruction as remove', () => {
    const removeVariants = instructions.filter(isRemoveLiquidity);
    // sanity: the IDL still carries the known remove variants we rely on
    expect(removeVariants).toContain('remove_all_liquidity');
    for (const name of removeVariants) {
      expect(classifyInstruction(onchainName(name)), name).toBe('remove');
    }
  });

  it('never misclassifies a non-remove-liquidity IDL instruction as remove', () => {
    for (const name of instructions.filter((n) => !isRemoveLiquidity(n))) {
      expect(classifyInstruction(onchainName(name)), name).not.toBe('remove');
    }
  });
});

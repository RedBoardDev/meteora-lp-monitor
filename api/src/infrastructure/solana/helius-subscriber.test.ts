import { describe, expect, it } from 'vitest';
import { classifyInstruction } from '@/domain/dlmm';
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
});

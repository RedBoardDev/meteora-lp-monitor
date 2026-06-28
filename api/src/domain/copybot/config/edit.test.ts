import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from './defaults';
import { addLeader, coerceValue, getAtPath, MAX_LEADERS, removeLeader, setAtPath } from './edit';
import { CopybotConfigSchema } from './schema';

const L = (i: number): string => `Leader${i}1111111111111111111111111111111111111`;

describe('config edit · getAtPath', () => {
  it('reads a nested value', () => {
    expect(getAtPath(CONFIG_DEFAULTS, 'user.sizing.tradeRatioPct')).toBe(100);
    expect(getAtPath(CONFIG_DEFAULTS, 'leaders.0.enabled')).toBe(true);
  });

  it('returns undefined for a missing path (no throw)', () => {
    expect(getAtPath(CONFIG_DEFAULTS, 'user.nope.deep')).toBeUndefined();
  });
});

describe('config edit · setAtPath (immutable)', () => {
  it('sets a nested value without mutating the source', () => {
    const next = setAtPath(CONFIG_DEFAULTS, 'user.sizing.tradeRatioPct', 25);
    expect(getAtPath(next, 'user.sizing.tradeRatioPct')).toBe(25);
    expect(CONFIG_DEFAULTS.user.sizing.tradeRatioPct).toBe(100); // source untouched
  });

  it('creates missing intermediate objects (set a not-yet-present leader override)', () => {
    const next = setAtPath(CONFIG_DEFAULTS, 'leaders.0.overrides.priorityFee.tier', 'high');
    expect(getAtPath(next, 'leaders.0.overrides.priorityFee.tier')).toBe('high');
  });

  it('throws when descending into a non-object leaf', () => {
    expect(() => setAtPath(CONFIG_DEFAULTS, 'user.sizing.tradeRatioPct.x', 1)).toThrow();
  });

  it('a set whose result violates the schema is caught by validation (caller guard)', () => {
    // WHY: the CLI sets then validates — a bad type must be rejected, never persisted.
    const next = setAtPath(CONFIG_DEFAULTS, 'user.sizing.maxTradeSizeSol', -5);
    expect(CopybotConfigSchema.safeParse(next).success).toBe(false);
  });
});

describe('config edit · coerceValue', () => {
  it('parses numbers, booleans, arrays; keeps bare tokens as strings', () => {
    expect(coerceValue('100')).toBe(100);
    expect(coerceValue('0.005')).toBe(0.005);
    expect(coerceValue('true')).toBe(true);
    expect(coerceValue('["A","B"]')).toEqual(['A', 'B']);
    expect(coerceValue('medium')).toBe('medium'); // not valid JSON → string
    expect(coerceValue('8ryctvNwpJ')).toBe('8ryctvNwpJ');
  });
});

describe('config edit · addLeader / removeLeader', () => {
  it('appends an enabled leader with empty overrides', () => {
    const next = addLeader({ ...CONFIG_DEFAULTS, leaders: [] }, L(1));
    expect(next.leaders).toEqual([{ address: L(1), enabled: true, overrides: {} }]);
  });

  it('rejects a duplicate leader', () => {
    expect(() => addLeader(CONFIG_DEFAULTS, CONFIG_DEFAULTS.leaders[0]!.address)).toThrow(/already followed/);
  });

  it('enforces the MAX_LEADERS SYSTEM cap', () => {
    let cfg = { ...CONFIG_DEFAULTS, leaders: [] as typeof CONFIG_DEFAULTS.leaders };
    for (let i = 0; i < MAX_LEADERS; i++) cfg = addLeader(cfg, L(i));
    expect(() => addLeader(cfg, L(99))).toThrow(/max/);
  });

  it('removes a followed leader and rejects an unknown one', () => {
    const addr = CONFIG_DEFAULTS.leaders[0]!.address;
    expect(removeLeader(CONFIG_DEFAULTS, addr).leaders).toHaveLength(0);
    expect(() => removeLeader(CONFIG_DEFAULTS, 'NopeNope')).toThrow(/not followed/);
  });
});

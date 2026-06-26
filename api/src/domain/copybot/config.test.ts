import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS, CopybotConfigSchema, type CopybotRuntimeConfig, isValidConfigBlob, mergeConfig, parseConfig } from './config';

describe('copybot config · defaults + schema', () => {
  it('CONFIG_DEFAULTS is a valid config (a fresh bot always has a coherent config)', () => {
    expect(CopybotConfigSchema.safeParse(CONFIG_DEFAULTS).success).toBe(true);
  });
});

describe('copybot config · parseConfig (fail-safe load)', () => {
  it('null / empty → defaults', () => {
    expect(parseConfig(null)).toEqual(CONFIG_DEFAULTS);
    expect(parseConfig('')).toEqual(CONFIG_DEFAULTS);
  });

  it('non-JSON → defaults (never throws)', () => {
    expect(parseConfig('}{not json')).toEqual(CONFIG_DEFAULTS);
  });

  it('a partial blob merges onto defaults — an unset field keeps its default (schema evolution safe)', () => {
    // WHY: the web (or an older bot) may store only the field it changed. Falling back the WHOLE config would be a
    // safety hole (e.g. a partial write must not silently reset the kill-switch). Only the unset fields default.
    const cfg = parseConfig(JSON.stringify({ caps: { killSwitchGlobal: true } }));
    expect(cfg.caps.killSwitchGlobal).toBe(true); // the stored override wins
    expect(cfg.caps.maxOpenPositions).toBe(CONFIG_DEFAULTS.caps.maxOpenPositions); // unset → default
    expect(cfg.sizing).toEqual(CONFIG_DEFAULTS.sizing); // untouched section → default
    expect(cfg.twoSidedMode).toBe(CONFIG_DEFAULTS.twoSidedMode);
  });

  it('a structurally invalid blob (wrong type) → full defaults', () => {
    // WHY: a corrupt blob must not feed garbage sizing/caps into the bot — fall back to known-good defaults.
    const cfg = parseConfig(JSON.stringify({ sizing: { maxTradeSizeSol: 'huge' } }));
    expect(cfg).toEqual(CONFIG_DEFAULTS);
  });

  it('rejects an unknown extra top-level key (strict schema) → defaults', () => {
    expect(parseConfig(JSON.stringify({ ...CONFIG_DEFAULTS, bogus: 1 }))).toEqual(CONFIG_DEFAULTS);
  });

  it('a full valid custom blob round-trips exactly', () => {
    const custom: CopybotRuntimeConfig = {
      leader: 'LeaderWalletPubkey1111111111111111111111111',
      sizing: { tradeRatioPct: 25, maxTradeSizeSol: 0.5, minPositionSizeSol: 0.1, solReserveSol: 0.03, onInsufficient: 'reduceToFit' },
      caps: { killSwitchGlobal: false, killSwitchLeader: true, maxOpenPositions: 3, maxConcurrentPerToken: 1, maxOpensPerWindow: 5, windowMinutes: 15, maxTotalExposureSol: 2 },
      twoSidedMode: 'on',
    };
    expect(parseConfig(JSON.stringify(custom))).toEqual(custom);
  });
});

describe('copybot config · mergeConfig', () => {
  it('deep-merges nested sizing/caps without dropping sibling fields', () => {
    const merged = mergeConfig(CONFIG_DEFAULTS, { sizing: { tradeRatioPct: 10 }, caps: { killSwitchGlobal: true } });
    expect(merged.sizing.tradeRatioPct).toBe(10);
    expect(merged.sizing.maxTradeSizeSol).toBe(CONFIG_DEFAULTS.sizing.maxTradeSizeSol); // sibling preserved
    expect(merged.caps.killSwitchGlobal).toBe(true);
    expect(merged.caps.maxOpenPositions).toBe(CONFIG_DEFAULTS.caps.maxOpenPositions); // sibling preserved
  });

  it('does not mutate the base', () => {
    const base = structuredClone(CONFIG_DEFAULTS);
    mergeConfig(base, { caps: { killSwitchGlobal: true } });
    expect(base.caps.killSwitchGlobal).toBe(false);
  });
});

describe('copybot config · isValidConfigBlob', () => {
  it('true for a valid (even partial) blob, false for null/garbage', () => {
    expect(isValidConfigBlob(JSON.stringify({ caps: { killSwitchGlobal: true } }))).toBe(true);
    expect(isValidConfigBlob(null)).toBe(false);
    expect(isValidConfigBlob('nope')).toBe(false);
    expect(isValidConfigBlob(JSON.stringify({ sizing: { maxTradeSizeSol: 'x' } }))).toBe(false);
  });
});

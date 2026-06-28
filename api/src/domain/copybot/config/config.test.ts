import { describe, expect, it } from 'vitest';
import {
  CONFIG_DEFAULTS,
  type CopybotConfig,
  CopybotConfigSchema,
  DEFAULT_LEADER_ADDRESS,
  effectiveFor,
  isValidConfigBlob,
  parseConfig,
  withEnvOverride,
} from './index';

const LEADER = DEFAULT_LEADER_ADDRESS;

describe('config · defaults + schema', () => {
  it('CONFIG_DEFAULTS is valid and has exactly one default leader', () => {
    expect(CopybotConfigSchema.safeParse(CONFIG_DEFAULTS).success).toBe(true);
    expect(CONFIG_DEFAULTS.leaders).toHaveLength(1);
    expect(CONFIG_DEFAULTS.leaders[0]!.address).toBe(LEADER);
  });

  it('the spec-locked defaults hold (a silent change to a policy default breaks this)', () => {
    // WHY: these are the agreed product defaults (docs/reference/copybot-settings.md). This pins them so a refactor
    // or a careless edit can't drift the fresh-bot policy unnoticed.
    const u = CONFIG_DEFAULTS.user;
    expect(u.sizing.tradeRatioPct).toBe(100); // follow the leader, capped (spec §3)
    expect(u.sizing.maxTradeSizeSol).toBe(1.0);
    expect(u.sizing.minPositionSizeSol).toBe(0.05);
    expect(u.caps.maxOpenPositions).toBe(8);
    expect(u.twoSidedMode).toBe('off'); // token-leg policy = skip
    expect(u.filters).toEqual(expect.objectContaining({ minJupOrganicScore: null })); // filters off by default (for now)
    expect(u.priorityFee).toEqual({ tier: 'medium', maxCapSol: 0.005 }); // spec §5
  });
});

describe('config · priorityFee', () => {
  it('a leader sparsely overrides the tier, the cap inherits', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [{ address: LEADER, enabled: true, overrides: { priorityFee: { tier: 'high' } } }],
    };
    const pf = effectiveFor(cfg, LEADER).priorityFee;
    expect(pf.tier).toBe('high');
    expect(pf.maxCapSol).toBe(CONFIG_DEFAULTS.user.priorityFee.maxCapSol); // sibling preserved
  });
});

describe('config · parseConfig (fail-safe + migration)', () => {
  it('null / empty / non-JSON → defaults', () => {
    expect(parseConfig(null)).toEqual(CONFIG_DEFAULTS);
    expect(parseConfig('')).toEqual(CONFIG_DEFAULTS);
    expect(parseConfig('}{')).toEqual(CONFIG_DEFAULTS);
  });

  it('a partial user block merges onto defaults — unset fields keep their default (no silent reset)', () => {
    const cfg = parseConfig(JSON.stringify({ user: { caps: { killSwitchGlobal: true } } }));
    expect(cfg.user.caps.killSwitchGlobal).toBe(true);
    expect(cfg.user.caps.maxOpenPositions).toBe(CONFIG_DEFAULTS.user.caps.maxOpenPositions);
    expect(cfg.user.sizing).toEqual(CONFIG_DEFAULTS.user.sizing);
  });

  it('migrates a legacy FLAT blob ({leader, sizing, caps, twoSidedMode}) into the two-tier shape', () => {
    // WHY: an existing dev config must not be lost when we restructure — it's transparently upgraded.
    const legacy = JSON.stringify({
      leader: 'LegacyLeader1111111111111111111111111111111',
      sizing: { tradeRatioPct: 25, maxTradeSizeSol: 0.5, minPositionSizeSol: 0.05, solReserveSol: 0.05, onInsufficient: 'skip' },
      caps: CONFIG_DEFAULTS.user.caps,
      twoSidedMode: 'on',
    });
    const cfg = parseConfig(legacy);
    expect(cfg.user.sizing.tradeRatioPct).toBe(25);
    expect(cfg.user.twoSidedMode).toBe('on');
    expect(cfg.leaders).toHaveLength(1);
    expect(cfg.leaders[0]!.address).toBe('LegacyLeader1111111111111111111111111111111');
  });

  it('a structurally invalid value → full defaults', () => {
    expect(parseConfig(JSON.stringify({ user: { sizing: { maxTradeSizeSol: 'huge' } } }))).toEqual(CONFIG_DEFAULTS);
  });

  it('round-trips a full valid two-tier blob', () => {
    const custom: CopybotConfig = {
      user: { ...CONFIG_DEFAULTS.user, twoSidedMode: 'shadow' },
      leaders: [{ address: LEADER, enabled: false, overrides: { twoSidedMode: 'on' } }],
    };
    expect(parseConfig(JSON.stringify(custom))).toEqual(custom);
  });
});

describe('config · isValidConfigBlob', () => {
  it('true for a valid (even partial) blob, false for null/garbage', () => {
    expect(isValidConfigBlob(JSON.stringify({ user: { caps: { killSwitchGlobal: true } } }))).toBe(true);
    expect(isValidConfigBlob(null)).toBe(false);
    expect(isValidConfigBlob('nope')).toBe(false);
    expect(isValidConfigBlob(JSON.stringify({ user: { sizing: { maxTradeSizeSol: 'x' } } }))).toBe(false);
  });
});

describe('config · effectiveFor', () => {
  it('with no overrides, returns the user defaults for that leader', () => {
    const eff = effectiveFor(CONFIG_DEFAULTS, LEADER);
    expect(eff.sizing).toEqual(CONFIG_DEFAULTS.user.sizing);
    expect(eff.twoSidedMode).toBe(CONFIG_DEFAULTS.user.twoSidedMode);
    expect(eff.leaderEnabled).toBe(true);
    expect(eff.caps.killSwitchLeader).toBe(false);
  });

  it('leader overrides win over user defaults (twoSided + sizing field)', () => {
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [{ address: LEADER, enabled: true, overrides: { twoSidedMode: 'on', sizing: { tradeRatioPct: 10 } } }],
    };
    const eff = effectiveFor(cfg, LEADER);
    expect(eff.twoSidedMode).toBe('on');
    expect(eff.sizing.tradeRatioPct).toBe(10);
    expect(eff.sizing.maxTradeSizeSol).toBe(CONFIG_DEFAULTS.user.sizing.maxTradeSizeSol); // sibling preserved
  });

  it('maxTradeSizeSol is LOWER-ONLY — a leader can tighten but never raise the user ceiling', () => {
    // WHY: a per-leader override must never increase risk beyond the account ceiling (a typo or a malicious config).
    const user = { ...CONFIG_DEFAULTS.user, sizing: { ...CONFIG_DEFAULTS.user.sizing, maxTradeSizeSol: 1.0 } };
    const raise: CopybotConfig = { user, leaders: [{ address: LEADER, enabled: true, overrides: { sizing: { maxTradeSizeSol: 5 } } }] };
    const lower: CopybotConfig = { user, leaders: [{ address: LEADER, enabled: true, overrides: { sizing: { maxTradeSizeSol: 0.3 } } }] };
    expect(effectiveFor(raise, LEADER).sizing.maxTradeSizeSol).toBe(1.0); // raise rejected → clamped to ceiling
    expect(effectiveFor(lower, LEADER).sizing.maxTradeSizeSol).toBe(0.3); // tighten honored
  });

  it('a disabled leader resolves to killSwitchLeader=true (so checkCaps blocks its opens)', () => {
    const cfg: CopybotConfig = { user: CONFIG_DEFAULTS.user, leaders: [{ address: LEADER, enabled: false, overrides: {} }] };
    const eff = effectiveFor(cfg, LEADER);
    expect(eff.leaderEnabled).toBe(false);
    expect(eff.caps.killSwitchLeader).toBe(true);
  });

  it('the user master switch off ⇒ killSwitchGlobal=true (no opens, exits still run)', () => {
    const cfg: CopybotConfig = { user: { ...CONFIG_DEFAULTS.user, enabled: false }, leaders: CONFIG_DEFAULTS.leaders };
    expect(effectiveFor(cfg, LEADER).caps.killSwitchGlobal).toBe(true);
  });

  it('an unknown leader address falls back to user defaults, treated as enabled', () => {
    const eff = effectiveFor(CONFIG_DEFAULTS, 'UnknownLeaderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    expect(eff.leaderEnabled).toBe(true);
    expect(eff.sizing).toEqual(CONFIG_DEFAULTS.user.sizing);
  });
});

describe('config · execution group', () => {
  it('effectiveFor returns the user execution defaults with no override', () => {
    expect(effectiveFor(CONFIG_DEFAULTS, LEADER).execution).toEqual(CONFIG_DEFAULTS.user.execution);
  });

  it('a leader sparsely overrides one execution field, the rest inherit', () => {
    // WHY: a volatile-token leader may need more slippage without touching the other execution tunables.
    const cfg: CopybotConfig = {
      user: CONFIG_DEFAULTS.user,
      leaders: [{ address: LEADER, enabled: true, overrides: { execution: { slippageBps: 300 } } }],
    };
    const ex = effectiveFor(cfg, LEADER).execution;
    expect(ex.slippageBps).toBe(300);
    expect(ex.dustTokenRaw).toBe(CONFIG_DEFAULTS.user.execution.dustTokenRaw); // sibling preserved
    expect(ex.reshapeBinDeadbandSol).toBe(CONFIG_DEFAULTS.user.execution.reshapeBinDeadbandSol);
  });

  it('a partial execution blob merges onto defaults (no silent reset of the other tunables)', () => {
    const cfg = parseConfig(JSON.stringify({ user: { execution: { minSellOutLamports: 1 } } }));
    expect(cfg.user.execution.minSellOutLamports).toBe(1);
    expect(cfg.user.execution.slippageBps).toBe(CONFIG_DEFAULTS.user.execution.slippageBps);
  });
});

describe('config · withEnvOverride (migration bridge)', () => {
  it('applies only the provided fields, leaving the rest of the resolved config intact', () => {
    const eff = effectiveFor(CONFIG_DEFAULTS, LEADER);
    const out = withEnvOverride(eff, { caps: { killSwitchGlobal: true, maxOpenPositions: 2 }, twoSidedMode: 'on' });
    expect(out.caps.killSwitchGlobal).toBe(true);
    expect(out.caps.maxOpenPositions).toBe(2);
    expect(out.twoSidedMode).toBe('on');
    expect(out.sizing).toEqual(eff.sizing); // untouched
  });

  it('an empty override is a no-op', () => {
    const eff = effectiveFor(CONFIG_DEFAULTS, LEADER);
    expect(withEnvOverride(eff, {})).toEqual(eff);
  });
});

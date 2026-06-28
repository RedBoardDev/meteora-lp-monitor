import { describe, expect, it } from 'vitest';
import {
  JOURNAL_KINDS,
  JOURNAL_OUTCOMES,
  JOURNAL_STAGES,
  type JournalEntry,
  type JournalOutcome,
  formatJournalLine,
  requiresReason,
  severityFor,
  stageForKind,
  validationWarning,
} from './journal';

describe('journal · severityFor', () => {
  // WHY: alerting + UI coloring branch on severity. If a regression silently downgraded a failed/rejected event
  // to info, an operator would never be paged for a vault refusal or a failed land — these MUST stay 'error'.
  it('failed and rejected are ALWAYS error (operator must be surfaced)', () => {
    expect(severityFor('failed')).toBe('error');
    expect(severityFor('rejected')).toBe('error');
  });

  it('blocked (cap / kill-switch hit) is a warn — operationally notable, not an error', () => {
    expect(severityFor('blocked')).toBe('warn');
  });

  it('normal progress + deliberate skips are info', () => {
    for (const o of ['detected', 'published', 'landed', 'confirmed', 'skipped', 'noop'] as const) {
      expect(severityFor(o)).toBe('info');
    }
  });

  it('every outcome maps to a defined severity (no outcome falls through the taxonomy)', () => {
    for (const o of JOURNAL_OUTCOMES) {
      expect(['info', 'warn', 'error']).toContain(severityFor(o));
    }
  });
});

describe('journal · requiresReason', () => {
  // WHY: the feed must always explain WHY something did not progress. A skip/block/fail/reject with no reason is a
  // hole in the audit trail — this invariant is what guarantees the web can render the cause for every such entry.
  it('skipped / blocked / failed / rejected require a reason', () => {
    for (const o of ['skipped', 'blocked', 'failed', 'rejected'] as const) {
      expect(requiresReason(o)).toBe(true);
    }
  });

  it('progress + noop outcomes do not require a reason', () => {
    for (const o of ['detected', 'published', 'landed', 'confirmed', 'noop'] as const) {
      expect(requiresReason(o)).toBe(false);
    }
  });
});

describe('journal · stageForKind', () => {
  // WHY: the generic publish-time journaling relies on this being TOTAL over every kind — a kind with no stage would
  // silently drop a published intent out of its lifecycle bucket. This guards the kind→stage contract.
  it('maps every leader/sign kind to a valid stage (total, no fall-through)', () => {
    for (const k of JOURNAL_KINDS) {
      expect(JOURNAL_STAGES).toContain(stageForKind(k));
    }
  });

  it('groups add/remove under reshape and buy under open (the two-sided funding step is part of opening)', () => {
    expect(stageForKind('add')).toBe('reshape');
    expect(stageForKind('remove')).toBe('reshape');
    expect(stageForKind('buy')).toBe('open');
    expect(stageForKind('open')).toBe('open');
    expect(stageForKind('close')).toBe('close');
    expect(stageForKind('sell')).toBe('sell');
  });
});

describe('journal · formatJournalLine (clean operator log)', () => {
  it('a skipped open shows the stage, outcome AND the reason (the user must see WHY an open did not happen)', () => {
    const line = formatJournalLine({ stage: 'open', outcome: 'skipped', reason: 'entry_filter', pool: '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6' });
    expect(line).toContain('OPEN');
    expect(line).toContain('skipped');
    expect(line).toContain('(entry_filter)'); // the WHY is always present
    expect(line).toContain('pool=5rCf…HAS6'); // pubkey abbreviated
  });

  it('a landed sign shows the kind, signature and latency', () => {
    const line = formatJournalLine({ stage: 'sign', outcome: 'landed', kind: 'close', signature: 'abcdefghijklmnopqrstuvwxyz', latencyMs: 1842 });
    expect(line).toContain('SIGN landed');
    expect(line).toContain('close');
    expect(line).toContain('sig=abcd…wxyz');
    expect(line).toContain('1842ms');
  });

  it('a noop renders a minimal clean line (no trailing separators)', () => {
    expect(formatJournalLine({ stage: 'reshape', outcome: 'noop' })).toBe('· RESHAPE noop');
  });

  it('does not duplicate the kind when it equals the stage', () => {
    const line = formatJournalLine({ stage: 'open', outcome: 'published', kind: 'open', ourSizeSol: 0.3 });
    expect(line).toBe('📤 OPEN published · 0.3 SOL'); // kind 'open' omitted (== stage), size shown
  });
});

describe('journal · validationWarning', () => {
  const base: JournalEntry = { stage: 'open', outcome: 'published' };

  it('flags a reason-required entry that has no reason (caught loudly, never silently dropped)', () => {
    const w = validationWarning({ ...base, outcome: 'skipped' });
    expect(w).toContain('missing a required reason');
    expect(w).toContain('outcome=skipped');
  });

  it('treats an empty-string reason as missing (no blank reasons sneak through)', () => {
    expect(validationWarning({ ...base, outcome: 'blocked', reason: '' })).not.toBeNull();
  });

  it('passes when a reason is present', () => {
    expect(validationWarning({ ...base, outcome: 'skipped', reason: 'entry_filter' })).toBeNull();
  });

  it('passes for progress outcomes regardless of reason', () => {
    const progress: JournalOutcome[] = ['published', 'landed', 'confirmed', 'detected', 'noop'];
    for (const outcome of progress) expect(validationWarning({ ...base, outcome })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { HealthMonitor } from './health-monitor';

describe('HealthMonitor circuit breaker', () => {
  it('goes lagging on the first failure, down after the threshold, and ok on any success', () => {
    const h = new HealthMonitor(3);
    h.record('rpc', false, '429');
    expect(h.statusOf('rpc')).toBe('lagging');
    h.record('rpc', false);
    h.record('rpc', false);
    expect(h.statusOf('rpc')).toBe('down');
    h.record('rpc', true);
    expect(h.statusOf('rpc')).toBe('ok');
  });

  it('overall ok is false when ANY recorded source is down, true otherwise', () => {
    const h = new HealthMonitor(1);
    expect(h.ok).toBe(true); // nothing recorded yet
    h.record('jupiter', true);
    expect(h.ok).toBe(true); // a healthy source keeps it ok
    h.record('rpc', false); // threshold 1 → immediately down
    expect(h.ok).toBe(false);
    h.record('rpc', true); // recovers
    expect(h.ok).toBe(true);
  });

  it('records detail + timestamps and exposes the source list + chain tip', () => {
    const h = new HealthMonitor();
    h.record('jupiter', false, 'timeout');
    h.setChainTip(123);
    const j = h.list().find((s) => s.name === 'jupiter');
    expect(j?.detail).toBe('timeout');
    expect(j?.lastErrorAt).not.toBeNull();
    expect(h.chainTipSlot).toBe(123);
  });

  it('set() records a directly-observed state without breaker counting', () => {
    const h = new HealthMonitor();
    h.set('ws', 'down', 'disconnected');
    expect(h.statusOf('ws')).toBe('down');
    expect(h.list().find((s) => s.name === 'ws')?.consecutiveErrors).toBe(0);
    h.set('ws', 'ok');
    expect(h.statusOf('ws')).toBe('ok');
  });
});

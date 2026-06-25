import type { Health } from '@binsight/shared';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event-bus';

const HEALTH = { rpc: 'ok' } as unknown as Health;

describe('EventBus — typed in-process pub/sub', () => {
  it('emit delivers the payload to every subscriber of that type', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('health', a);
    bus.on('health', b);
    bus.emit('health', HEALTH);
    expect(a).toHaveBeenCalledWith(HEALTH);
    expect(b).toHaveBeenCalledWith(HEALTH);
  });

  it('the unsubscribe fn returned by on() stops further delivery (and only to that handler)', () => {
    const bus = new EventBus();
    const keep = vi.fn();
    const drop = vi.fn();
    bus.on('health', keep);
    const off = bus.on('health', drop);
    off();
    bus.emit('health', HEALTH);
    expect(keep).toHaveBeenCalledTimes(1);
    expect(drop).not.toHaveBeenCalled();
  });

  it('does not cross-deliver between event types', () => {
    const bus = new EventBus();
    const onClosed = vi.fn();
    bus.on('closedChanged', onClosed);
    bus.emit('health', HEALTH); // different type → no delivery
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('a THROWING subscriber never breaks the emitter — later subscribers still fire', () => {
    // The isolation guarantee: one bad subscriber must not drop the event for the others (e.g. the WS layer must
    // still get a health update even if the notification manager's handler throws).
    const bus = new EventBus();
    const thrower = vi.fn(() => {
      throw new Error('subscriber blew up');
    });
    const after = vi.fn();
    bus.on('health', thrower);
    bus.on('health', after);
    expect(() => bus.emit('health', HEALTH)).not.toThrow();
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1); // delivery continued past the throw
  });
});

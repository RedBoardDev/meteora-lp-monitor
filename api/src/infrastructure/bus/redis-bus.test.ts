import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RedisBus } from './redis-bus';

// Integration test: requires the local Redis container (docker compose up -d redis → :6385).
const URL = process.env.REDIS_URL ?? 'redis://localhost:6385';
const STREAM = 'test:copybot:cmd:sign';
const GROUP = 'test-coffre';
const KEY = 'k_sign_test';

let bus: RedisBus;

beforeAll(async () => {
  bus = RedisBus.connect(URL);
  await bus.del(STREAM, `${STREAM}.DLQ`); // clean slate
  await bus.ensureGroup(STREAM, GROUP);
});

afterAll(async () => {
  await bus.del(STREAM, `${STREAM}.DLQ`);
  await bus.quit();
});

describe('RedisBus — Redis Streams + HMAC (integration)', () => {
  it('publish → consume: authenticated round-trip', async () => {
    const payload = { commandId: 'c1', kind: 'open', sizeSol: 0.5 };
    await bus.publish(STREAM, 'cmd:sign', KEY, payload);
    const msgs = await bus.consume(STREAM, GROUP, 'consumer-1', 'cmd:sign', KEY, 10, 2000);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.payload).toEqual(payload);
    const id = msgs[0]?.id;
    if (id) await bus.ack(STREAM, GROUP, id);
  });

  it('different hop on publish → rejected on consume (payload null, not parsed)', async () => {
    await bus.publish(STREAM, 'cmd:execute', KEY, { x: 1 }); // wrong hop → incompatible MAC
    const msgs = await bus.consume(STREAM, GROUP, 'consumer-1', 'cmd:sign', KEY, 10, 2000);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.payload).toBeNull();
    const id = msgs[0]?.id;
    if (id) await bus.ack(STREAM, GROUP, id);
  });

  it('consumePending recovers a delivered-but-unACKed cmd:sign (crash recovery — NEVER strands an in-flight close)', async () => {
    // WHY: a vault that read a cmd:sign then crashed before ACK must re-process it on boot, or a close could be lost.
    // consumePending re-reads THIS consumer's PEL (XREADGROUP id '0'); the executions table makes the replay safe.
    const payload = { commandId: 'pend1', kind: 'close', sizeSol: 1 };
    const consumer = 'consumer-crash';
    await bus.publish(STREAM, 'cmd:sign', KEY, payload);
    const first = await bus.consume(STREAM, GROUP, consumer, 'cmd:sign', KEY, 10, 2000);
    expect(first).toHaveLength(1); // delivered to this consumer, but we deliberately DON'T ack (the "crash")

    const pending = await bus.consumePending(STREAM, GROUP, consumer, 'cmd:sign', KEY);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toEqual(payload); // recovered AND HMAC-authenticated, not lost
    const id = pending[0]?.id;
    if (id) await bus.ack(STREAM, GROUP, id); // now ack → cleared from the PEL
    const afterAck = await bus.consumePending(STREAM, GROUP, consumer, 'cmd:sign', KEY);
    expect(afterAck).toHaveLength(0); // once ACKed, no longer pending (not re-processed forever)
  });
});

// Group-creation + DLQ semantics, tested deterministically against a fake ioredis (no container needed): idempotent
// group creation must SWALLOW BUSYGROUP (re-running the vault is normal) but RETHROW a real failure (fail-loud), and
// the DLQ must copy the exact raw fields then ACK the original (so a rejected message is preserved AND not redelivered).
describe('RedisBus — ensureGroup idempotency + deadLetter (fake redis)', () => {
  it('ensureGroup SWALLOWS BUSYGROUP — re-creating an existing group is a no-op', async () => {
    const xgroup = vi.fn(async () => {
      throw new Error('BUSYGROUP Consumer Group name already exists');
    });
    const bus = new RedisBus({ xgroup } as never);
    await expect(bus.ensureGroup('cmd:sign', 'coffre')).resolves.toBeUndefined();
  });

  it('ensureGroup RETHROWS a non-BUSYGROUP error — a real Redis failure must surface, not be hidden', async () => {
    const xgroup = vi.fn(async () => {
      throw new Error('NOAUTH Authentication required');
    });
    const bus = new RedisBus({ xgroup } as never);
    await expect(bus.ensureGroup('cmd:sign', 'coffre')).rejects.toThrow('NOAUTH');
  });

  it('deadLetter copies the EXACT raw fields onto <stream>.DLQ, then ACKs the original', async () => {
    const xadd = vi.fn(async () => '1-0');
    const xack = vi.fn(async () => 1);
    const bus = new RedisBus({ xadd, xack } as never);
    await bus.deadLetter('cmd:sign', 'coffre', '42-0', { body: 'RAW_BODY', hmac: 'RAW_HMAC' });
    expect(xadd).toHaveBeenCalledWith('cmd:sign.DLQ', '*', 'body', 'RAW_BODY', 'hmac', 'RAW_HMAC');
    expect(xack).toHaveBeenCalledWith('cmd:sign', 'coffre', '42-0'); // original ACKed → never redelivered
  });
});

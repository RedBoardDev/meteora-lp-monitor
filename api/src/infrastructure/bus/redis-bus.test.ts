import Redis from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('consume exposes the EXACT raw fields → deadLetter(raw) quarantines a poison message verbatim (no silent drop)', async () => {
    // WHY: a rejected/poison cmd:sign must be preserved for forensics, not ACKed-and-forgotten. The consumer now
    // carries the raw body/hmac so the coffre can dead-letter it verbatim (the durable trace FIX A adds).
    await bus.publish(STREAM, 'cmd:sign', KEY, { commandId: 'poison1', kind: 'open' });
    const msgs = await bus.consume(STREAM, GROUP, 'consumer-dlq', 'cmd:sign', KEY, 10, 2000);
    expect(msgs).toHaveLength(1);
    const msg = msgs[0];
    expect(msg?.raw).toHaveProperty('body'); // raw fields surfaced
    expect(msg?.raw).toHaveProperty('hmac');
    if (msg) await bus.deadLetter(STREAM, GROUP, msg.id, msg.raw);
    // The exact raw fields landed on the DLQ stream, byte-for-byte.
    const raw = new Redis(URL, { maxRetriesPerRequest: null, lazyConnect: false });
    const dlq = await raw.xrange(`${STREAM}.DLQ`, '-', '+');
    expect(dlq).toHaveLength(1);
    const fields = dlq[0]?.[1] ?? [];
    expect(fields).toEqual(['body', msg?.raw.body, 'hmac', msg?.raw.hmac]);
    // ...and it is no longer pending in the main group (ACKed by deadLetter → never redelivered).
    const pending = await bus.consumePending(STREAM, GROUP, 'consumer-dlq', 'cmd:sign', KEY);
    expect(pending).toHaveLength(0);
    await raw.quit();
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

// Stream-loss / NOGROUP resilience (deterministic, fake ioredis — no container). The group must anchor at '0'
// (no-miss: catch pre-group + post-flush messages) and a read that throws NOGROUP (Redis dropped the group) must
// re-create it and retry ONCE instead of wedging the consumer's outer backoff loop forever. Replay is safe because
// consumers dedup (executions table / idempotent ev:executed handlers). A NON-NOGROUP error must still surface so
// the caller's connection-backoff keeps working — we don't turn every read failure into a group re-create.
describe('RedisBus — NOGROUP self-heal + \'0\' anchor (fake redis)', () => {
  const KEY = 'k_sign_test';

  it("ensureGroup anchors the group at '0' (replay-safe no-miss), NOT '$'", async () => {
    const xgroup = vi.fn(async () => 'OK');
    const bus = new RedisBus({ xgroup } as never);
    await bus.ensureGroup('cmd:sign', 'coffre');
    expect(xgroup).toHaveBeenCalledWith('CREATE', 'cmd:sign', 'coffre', '0', 'MKSTREAM');
  });

  it('consume re-creates the group and retries ONCE on NOGROUP (self-heal, not wedged)', async () => {
    let calls = 0;
    const xreadgroup = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('NOGROUP No such key or consumer group in XREADGROUP');
      return null; // retry after the heal → empty read, no throw
    });
    const xgroup = vi.fn(async () => 'OK');
    const bus = new RedisBus({ xreadgroup, xgroup } as never);
    const msgs = await bus.consume('cmd:sign', 'coffre', 'c1', 'cmd:sign', KEY, 10, 100);
    expect(msgs).toEqual([]); // recovered (old code would REJECT here → the consumer loop wedges)
    expect(xgroup).toHaveBeenCalledWith('CREATE', 'cmd:sign', 'coffre', '0', 'MKSTREAM'); // group re-created
    expect(xreadgroup).toHaveBeenCalledTimes(2); // original throw + one retry
  });

  it('consumePending ALSO self-heals on NOGROUP (a stranded in-flight close must never wedge)', async () => {
    let calls = 0;
    const xreadgroup = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('NOGROUP the consumer group was dropped');
      return null;
    });
    const xgroup = vi.fn(async () => 'OK');
    const bus = new RedisBus({ xreadgroup, xgroup } as never);
    const msgs = await bus.consumePending('cmd:sign', 'coffre', 'c1', 'cmd:sign', KEY);
    expect(msgs).toEqual([]);
    expect(xgroup).toHaveBeenCalledTimes(1); // re-created exactly once
    expect(xreadgroup).toHaveBeenCalledTimes(2);
  });

  it('a NON-NOGROUP read error rethrows WITHOUT re-creating the group (keeps the connection-backoff intact)', async () => {
    const xreadgroup = vi.fn(async () => {
      throw new Error('ECONNRESET socket hang up');
    });
    const xgroup = vi.fn(async () => 'OK');
    const bus = new RedisBus({ xreadgroup, xgroup } as never);
    await expect(bus.consume('cmd:sign', 'coffre', 'c1', 'cmd:sign', KEY, 10, 100)).rejects.toThrow('ECONNRESET');
    expect(xgroup).not.toHaveBeenCalled(); // a genuine connection error is NOT a group loss → no re-create
    expect(xreadgroup).toHaveBeenCalledTimes(1); // and NO retry
  });
});

// End-to-end resilience against a live Redis (:6385). Proves the two no-miss guarantees on the real server:
// (1) '0' catches a message published BEFORE the group existed; (2) after the group is DESTROYED (Redis eviction /
// restart-empty), consume self-heals and still delivers the backlog instead of throwing NOGROUP forever.
describe('RedisBus — stream-loss resilience (integration)', () => {
  it("'0' anchor: a group created AFTER a publish still sees the pre-existing message ('$' would miss it)", async () => {
    const stream = 'test:copybot:zero-anchor';
    const group = 'late-group';
    const admin = RedisBus.connect(URL);
    await admin.del(stream);
    await admin.publish(stream, 'cmd:sign', KEY, { commandId: 'pre1', kind: 'open' }); // BEFORE any group exists
    await admin.ensureGroup(stream, group); // group created LATE → '0' replays from the stream head
    const msgs = await admin.consume(stream, group, 'c1', 'cmd:sign', KEY, 10, 2000);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.payload).toEqual({ commandId: 'pre1', kind: 'open' });
    await admin.del(stream);
    await admin.quit();
  });

  it('consume self-heals after XGROUP DESTROY (Redis dropped the group → NOGROUP) and re-delivers the backlog', async () => {
    const stream = 'test:copybot:nogroup';
    const group = 'heal-group';
    const raw = new Redis(URL, { maxRetriesPerRequest: null, lazyConnect: false });
    const bus2 = RedisBus.connect(URL);
    await bus2.del(stream);
    await bus2.ensureGroup(stream, group);
    await bus2.publish(stream, 'cmd:sign', KEY, { commandId: 'heal1', kind: 'close' });
    await raw.xgroup('DESTROY', stream, group); // simulate the group being lost (eviction / restart-empty)
    // old code: xreadgroup throws NOGROUP, the caller backs off forever. new code: ensureGroup re-runs + retry.
    const msgs = await bus2.consume(stream, group, 'c1', 'cmd:sign', KEY, 10, 2000);
    expect(msgs).toHaveLength(1); // re-created at '0' → the close is re-delivered, not lost
    expect(msgs[0]?.payload).toEqual({ commandId: 'heal1', kind: 'close' });
    await bus2.del(stream);
    await raw.quit();
    await bus2.quit();
  });
});

// Singleton lease (integration, :6385). The boot guard that stops a 2nd coffre from double-signing the shared PEL.
// Each `it` starts from a clean key. The double-acquire test is the fail-against-old proof: WITHOUT the lease a 2nd
// instance would boot and re-sign in-flight commands.
describe('RedisBus — singleton lease (integration)', () => {
  const LEASE = 'test:copybot:coffre:lease';

  beforeEach(async () => {
    await bus.del(LEASE);
  });
  afterAll(async () => {
    await bus.del(LEASE);
  });

  it('first acquire succeeds; a second instance while held is REFUSED (prevents a double-sign on boot)', async () => {
    expect(await bus.acquireLease(LEASE, 'inst-A', 5000)).toBe(true);
    // FAIL-AGAINST-OLD: with no lease, inst-B would have booted and re-signed in-flight cmd:sign → double execution.
    expect(await bus.acquireLease(LEASE, 'inst-B', 5000)).toBe(false);
    await bus.releaseLease(LEASE, 'inst-A');
  });

  it('after release the lease is re-acquirable (a clean restart takes over)', async () => {
    expect(await bus.acquireLease(LEASE, 'inst-A', 5000)).toBe(true);
    await bus.releaseLease(LEASE, 'inst-A');
    expect(await bus.acquireLease(LEASE, 'inst-B', 5000)).toBe(true);
    await bus.releaseLease(LEASE, 'inst-B');
  });

  it("after TTL expiry a crashed holder's lease is re-acquirable (no manual cleanup)", async () => {
    expect(await bus.acquireLease(LEASE, 'inst-crashed', 200)).toBe(true);
    await new Promise((r) => setTimeout(r, 350)); // let the short TTL lapse (simulates a crashed holder)
    expect(await bus.acquireLease(LEASE, 'inst-restart', 5000)).toBe(true);
    await bus.releaseLease(LEASE, 'inst-restart');
  });

  it('renew extends OUR lease; a non-holder can neither renew nor release it (CAS-guarded)', async () => {
    expect(await bus.acquireLease(LEASE, 'inst-A', 400)).toBe(true);
    expect(await bus.renewLease(LEASE, 'inst-B', 5000)).toBe(false); // not the holder → cannot renew
    expect(await bus.renewLease(LEASE, 'inst-A', 5000)).toBe(true); // holder → TTL extended to 5s
    await new Promise((r) => setTimeout(r, 450)); // past the ORIGINAL 400ms ttl — only the renew keeps it alive
    expect(await bus.acquireLease(LEASE, 'inst-B', 5000)).toBe(false); // still held → renew genuinely extended it
    await bus.releaseLease(LEASE, 'inst-B'); // non-holder release is a no-op (must not free A's lease)
    expect(await bus.acquireLease(LEASE, 'inst-B', 5000)).toBe(false); // A still holds it
    await bus.releaseLease(LEASE, 'inst-A');
  });
});

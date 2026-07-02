/**
 * Copy-bot · Inc.1 — Redis Streams bus (I/O). UNRELIABLE transport: integrity comes from the HMAC envelope
 * (`envelope.ts`), not from Redis. The brain `publish`es on `cmd:sign`; the vault `consume`s in pull-only
 * mode (XREADGROUP, no inbound socket). The expected `hop` is passed to consume → a message from another hop
 * (different MAC) is rejected (`payload: null`) without being parsed.
 */
import Redis from 'ioredis';
import { encodeEnvelope, verifyEnvelope } from './envelope';

export interface ConsumedMessage {
  id: string;
  /** authenticated payload, or `null` if the MAC/hop does not match (→ caller DLQ + ACK). */
  payload: unknown | null;
  /** the EXACT raw stream fields (`body`/`hmac`) as read — needed to dead-letter a rejected/poison message verbatim. */
  raw: Record<string, string>;
}

const fieldsToRecord = (fields: string[]): Record<string, string> => {
  const r: Record<string, string> = {};
  for (let i = 0; i + 1 < fields.length; i += 2) r[fields[i] as string] = fields[i + 1] as string;
  return r;
};

export class RedisBus {
  constructor(private readonly redis: Redis) {}

  static connect(url: string): RedisBus {
    return new RedisBus(new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false }));
  }

  /** Publishes a signed payload (HMAC, bound to the hop) onto a stream. Returns the message id. */
  async publish(stream: string, hop: string, key: string, payload: unknown): Promise<string> {
    const env = encodeEnvelope(hop, key, payload);
    const id = await this.redis.xadd(stream, '*', 'body', env.body, 'hmac', env.hmac);
    return id as string;
  }

  /** Creates the consumer-group if it does not exist (idempotent, MKSTREAM).
   *  Anchored at `'0'` (not `'$'`): the group replays from the START of the stream. Replay-safe because consumers
   *  dedup (coffre = executions table INSERT-before-sign; brain = idempotent ev:executed handlers), and `'0'` is the
   *  no-miss anchor — it catches messages published BEFORE the group existed (startup race) AND everything after a
   *  Redis flush/eviction when a group is later re-created; `'$'` would silently drop both. Keep the BUSYGROUP swallow.
   *  OPS FOLLOW-UP (separate change, not here): because a group re-creation now replays the whole backlog, the streams
   *  (`cmd:sign`, `ev:executed`) must be bounded in deployment via `XADD ... MAXLEN ~N` and/or a scheduled `XTRIM`. */
  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
    }
  }

  /** Runs an XREADGROUP read; if the group has vanished (Redis flush/eviction dropped it → the read throws NOGROUP),
   *  re-create the group and retry the read ONCE. Without this self-heal the consumer's outer loop just backs off
   *  forever on the NOGROUP throw and stays wedged (it never re-creates the group). Replay-safe: see `ensureGroup`. */
  private async readWithGroupHeal(
    stream: string,
    group: string,
    read: () => Promise<unknown>,
  ): Promise<Array<[string, Array<[string, string[]]>]> | null> {
    try {
      return (await read()) as Array<[string, Array<[string, string[]]>]> | null;
    } catch (err) {
      if (!(err as Error).message.includes('NOGROUP')) throw err;
      await this.ensureGroup(stream, group);
      return (await read()) as Array<[string, Array<[string, string[]]>]> | null;
    }
  }

  /** Reads (pulls) a batch via XREADGROUP, verifies each envelope against the expected hop, returns the
   *  messages (authenticated payload or null). Blocks up to `blockMs` if there is nothing to read. */
  async consume(
    stream: string,
    group: string,
    consumer: string,
    hop: string,
    key: string,
    count = 10,
    blockMs = 5000,
  ): Promise<ConsumedMessage[]> {
    const res = await this.readWithGroupHeal(stream, group, () =>
      this.redis.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'BLOCK', blockMs, 'STREAMS', stream, '>'),
    );
    return this.parse(res, hop, key);
  }

  /** Re-read THIS consumer's PENDING (delivered-but-unACKed) messages — XREADGROUP with id '0' returns the
   *  consumer's PEL (no BLOCK). A crashed prior instance read these but never ACKed; on boot the vault re-processes
   *  them (exactly-once via the executions table) so an in-flight cmd:sign is NEVER stranded by a crash. */
  async consumePending(stream: string, group: string, consumer: string, hop: string, key: string, count = 100): Promise<ConsumedMessage[]> {
    const res = await this.readWithGroupHeal(stream, group, () =>
      this.redis.xreadgroup('GROUP', group, consumer, 'COUNT', count, 'STREAMS', stream, '0'),
    );
    return this.parse(res, hop, key);
  }

  private parse(res: Array<[string, Array<[string, string[]]>]> | null, hop: string, key: string): ConsumedMessage[] {
    if (!res || res.length === 0) return [];
    const entries = res[0]?.[1] ?? [];
    return entries.map(([id, fields]) => {
      const f = fieldsToRecord(fields);
      const payload = f.body !== undefined && f.hmac !== undefined ? verifyEnvelope(hop, key, { body: f.body, hmac: f.hmac }) : null;
      return { id, payload, raw: f };
    });
  }

  async ack(stream: string, group: string, id: string): Promise<void> {
    await this.redis.xack(stream, group, id);
  }

  /** DLQ: copies the raw message onto the `<stream>.DLQ` stream then ACKs the original. */
  async deadLetter(stream: string, group: string, id: string, raw: Record<string, string>): Promise<void> {
    const flat = Object.entries(raw).flat();
    await this.redis.xadd(`${stream}.DLQ`, '*', ...flat);
    await this.redis.xack(stream, group, id);
  }

  // ── Singleton lease (ops mutual-exclusion, NOT a signing primitive) ─────────────────────────────────────────
  // A boot guard so only ONE coffre instance ever owns the shared consumer/PEL. A 2nd instance booting with the same
  // consumer would re-claim/re-sign in-flight `cmd:sign` from the PEL and DOUBLE-execute — the lease makes it refuse.

  /** `SET key=instanceId NX PX ttlMs`. Returns true iff THIS instance acquired the lease (no live holder). */
  async acquireLease(key: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const res = await this.redis.set(key, instanceId, 'PX', ttlMs, 'NX');
    return res === 'OK';
  }

  /**
   * Renew OUR lease (compare-and-set: extend the TTL only if the stored value is still our instanceId — NEVER steal a
   * lease that expired and was re-acquired by another instance). Returns true iff the TTL was extended. Runs on a
   * ttl/2 timer; a false return means we lost exclusivity and the caller must stop (split-brain guard).
   */
  async renewLease(key: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const res = (await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
      1,
      key,
      instanceId,
      String(ttlMs),
    )) as number;
    return res === 1;
  }

  /** Release OUR lease on graceful shutdown (compare-and-set delete: never delete another instance's lease). */
  async releaseLease(key: string, instanceId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      key,
      instanceId,
    );
  }

  async del(...streams: string[]): Promise<void> {
    if (streams.length > 0) await this.redis.del(...streams);
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

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

  /** Creates the consumer-group if it does not exist (idempotent, MKSTREAM). */
  async ensureGroup(stream: string, group: string): Promise<void> {
    try {
      await this.redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
    } catch (err) {
      if (!(err as Error).message.includes('BUSYGROUP')) throw err;
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
    const res = (await this.redis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      count,
      'BLOCK',
      blockMs,
      'STREAMS',
      stream,
      '>',
    )) as Array<[string, Array<[string, string[]]>]> | null;
    if (!res || res.length === 0) return [];
    const entries = res[0]?.[1] ?? [];
    return entries.map(([id, fields]) => {
      const f = fieldsToRecord(fields);
      const payload = f.body !== undefined && f.hmac !== undefined ? verifyEnvelope(hop, key, { body: f.body, hmac: f.hmac }) : null;
      return { id, payload };
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

  async del(...streams: string[]): Promise<void> {
    if (streams.length > 0) await this.redis.del(...streams);
  }

  async quit(): Promise<void> {
    await this.redis.quit();
  }
}

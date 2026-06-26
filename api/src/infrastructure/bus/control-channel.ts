/**
 * Copy-bot · control channel (Redis pub/sub). Carries lightweight "config changed → reload now" pings so a web
 * config edit (kill-switch, sizing, caps…) takes effect in <100ms instead of waiting for the periodic DB poll.
 *
 * The DB stays the SINGLE source of truth — a ping only triggers an early reload from it. So a spoofed or duplicate
 * ping is harmless (the bot re-reads the same validated config, never a second source of state), which is why the
 * channel needs no HMAC. The periodic DB poll remains the backstop if a ping is ever missed (e.g. a brief Redis
 * disconnect): worst case the change applies within the poll interval, best case in <100ms.
 *
 * Pub/sub (not Streams) is deliberate: the message is ephemeral ("reload now"), it must NOT be persisted/replayed,
 * and there is no consumer-group semantics to preserve — durability lives in Postgres, not here.
 */
import Redis from 'ioredis';

export const CONTROL_CHANNEL = 'copybot:control';

export const CONTROL_MESSAGE_TYPES = ['config-changed'] as const;
export type ControlMessageType = (typeof CONTROL_MESSAGE_TYPES)[number];
export interface ControlMessage {
  type: ControlMessageType;
}

/** Pure: parse a raw channel payload into a known control message, or null if unrecognized. Never throws. */
export function parseControlMessage(raw: string): ControlMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const type = (parsed as { type?: unknown }).type;
  if (typeof type !== 'string' || !(CONTROL_MESSAGE_TYPES as readonly string[]).includes(type)) return null;
  return { type: type as ControlMessageType };
}

export class ControlChannel {
  private constructor(
    private readonly pub: Redis,
    private readonly sub: Redis, // a subscribed connection can't issue other commands → separate from `pub`
  ) {}

  static connect(url: string): ControlChannel {
    const opts = { maxRetriesPerRequest: null, lazyConnect: false } as const;
    return new ControlChannel(new Redis(url, opts), new Redis(url, opts));
  }

  /** Fire a control message to all subscribers (the bot processes). Used by the web after persisting a config edit. */
  async publish(msg: ControlMessage): Promise<void> {
    await this.pub.publish(CONTROL_CHANNEL, JSON.stringify(msg));
  }

  /** Subscribe; `onMessage` runs for each VALID control message (malformed payloads are ignored, never thrown). */
  async subscribe(onMessage: (msg: ControlMessage) => void): Promise<void> {
    await this.sub.subscribe(CONTROL_CHANNEL);
    this.sub.on('message', (_channel, raw) => {
      const msg = parseControlMessage(raw);
      if (msg) onMessage(msg);
    });
  }

  async quit(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

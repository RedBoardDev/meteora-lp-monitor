import { afterAll, describe, expect, it } from 'vitest';
import { type ControlMessage, ControlChannel, parseControlMessage } from './control-channel';

describe('parseControlMessage (pure)', () => {
  it('accepts a known config-changed message', () => {
    expect(parseControlMessage(JSON.stringify({ type: 'config-changed' }))).toEqual({ type: 'config-changed' });
  });

  it('ignores malformed JSON, non-objects, missing/unknown types (never throws)', () => {
    expect(parseControlMessage('not json')).toBeNull();
    expect(parseControlMessage('42')).toBeNull();
    expect(parseControlMessage(JSON.stringify({}))).toBeNull();
    expect(parseControlMessage(JSON.stringify({ type: 'reboot-the-server' }))).toBeNull(); // unknown type rejected
    expect(parseControlMessage(JSON.stringify({ type: 42 }))).toBeNull();
  });
});

// Integration: requires local Redis (:6385).
const URL = process.env.REDIS_URL ?? 'redis://localhost:6385';

describe('ControlChannel (integration)', () => {
  const channels: ControlChannel[] = [];
  afterAll(async () => {
    await Promise.all(channels.map((c) => c.quit()));
  });

  it('delivers a published control message to a subscriber (the instant-reload path)', async () => {
    const subClient = ControlChannel.connect(URL);
    const pubClient = ControlChannel.connect(URL);
    channels.push(subClient, pubClient);

    let resolveReceived!: (m: ControlMessage) => void;
    const received = new Promise<ControlMessage>((resolve) => {
      resolveReceived = resolve;
    });
    // AWAIT the SUBSCRIBE before publishing: subscribe() resolves only after `sub.subscribe` is acked AND the
    // message handler is attached, so the subscription is provably live. Redis pub/sub drops a message with no
    // live subscriber, so the old fixed 150ms sleep was a race (a slow SUBSCRIBE round-trip under parallel load →
    // publish outran it → message lost → flaky timeout). Awaiting the ack makes it deterministic.
    await subClient.subscribe((m) => resolveReceived(m));
    await pubClient.publish({ type: 'config-changed' });

    const msg = await Promise.race([
      received,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('control message not delivered in time')), 5000)),
    ]);
    expect(msg).toEqual({ type: 'config-changed' });
  });
});

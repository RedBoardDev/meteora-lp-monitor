import { describe, expect, it } from 'vitest';
import { parseSubAck, parseTxNotification } from './helius-tx-subscriber';

// REAL subscription response observed on the Developer plan (2026-06-24).
const SUB_ACK = { jsonrpc: '2.0', id: 1, result: 3084839 };

// Notification in Helius's DOCUMENTED FORMAT (transactionSubscribe).
const TX_NOTIF = {
  jsonrpc: '2.0',
  method: 'transactionNotification',
  params: {
    subscription: 4743323479349712,
    result: {
      signature: '5moMXe6VW7L7aQZskcAkKGQ1y19qqUT1teQKBNAAmipzdxdqVLAdG47WrsByFYNJSAGa9TByv15oygnqYvP6Hn2p',
      transaction: {
        transaction: ['...base64...'],
        meta: { logMessages: ['Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]'], postTokenBalances: [] },
      },
      slot: 224341380,
    },
  },
};

describe('helius-tx-subscriber — frame parsing (documented format + real ack)', () => {
  it('parseSubAck extracts id + subId from the confirmation', () => {
    expect(parseSubAck(SUB_ACK)).toEqual({ id: 1, subId: 3084839 });
  });

  it('parseSubAck returns null on a notification (not an ack)', () => {
    expect(parseSubAck(TX_NOTIF)).toBeNull();
  });

  it('parseTxNotification extracts subId, signature and logs', () => {
    const n = parseTxNotification(TX_NOTIF);
    expect(n).not.toBeNull();
    expect(n?.subId).toBe(4743323479349712);
    expect(n?.signature).toBe(
      '5moMXe6VW7L7aQZskcAkKGQ1y19qqUT1teQKBNAAmipzdxdqVLAdG47WrsByFYNJSAGa9TByv15oygnqYvP6Hn2p',
    );
    expect(n?.logs).toContain('Program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo invoke [1]');
  });

  it('parseTxNotification returns null on an ack (not a notification)', () => {
    expect(parseTxNotification(SUB_ACK)).toBeNull();
  });

  it('parseTxNotification tolerates absent logs (→ [])', () => {
    const noMeta = {
      method: 'transactionNotification',
      params: { subscription: 7, result: { signature: 'sig', transaction: {} } },
    };
    expect(parseTxNotification(noMeta)?.logs).toEqual([]);
  });
});

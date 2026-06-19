import { SOL_MINT } from '@binsight/shared';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { type DasTransport, HeliusTokenMetadataGateway } from './token-metadata-gateway';

const silent = pino({ level: 'silent' });
const make = (transport: DasTransport) =>
  new HeliusTokenMetadataGateway('http://x', silent, 2, transport);

describe('HeliusTokenMetadataGateway', () => {
  it('serves stable mints (SOL) locally without touching the transport', async () => {
    const transport = vi.fn<DasTransport>(async () => new Map());
    const m = await make(transport).resolve([SOL_MINT]);
    expect(m.get(SOL_MINT)).toEqual({ symbol: 'SOL' });
    expect(transport).not.toHaveBeenCalled();
  });

  it('resolves an unknown mint via the transport (symbol + icon)', async () => {
    const transport = vi.fn<DasTransport>(
      async (mints) => new Map(mints.map((x) => [x, { symbol: 'MEME', icon: 'img' }])),
    );
    const m = await make(transport).resolve(['MintAAAA1111']);
    expect(m.get('MintAAAA1111')).toEqual({ symbol: 'MEME', icon: 'img' });
  });

  it('falls back to a truncated address when the transport returns no symbol', async () => {
    const transport = vi.fn<DasTransport>(async () => new Map());
    const m = await make(transport).resolve(['Abcd1234567890XYZ']);
    expect(m.get('Abcd1234567890XYZ')).toEqual({ symbol: 'Abcd…0XYZ' });
  });

  it('caches resolved metadata so a second resolve does not re-fetch', async () => {
    const transport = vi.fn<DasTransport>(
      async (mints) => new Map(mints.map((x) => [x, { symbol: 'M' }])),
    );
    const gw = make(transport);
    await gw.resolve(['mintX']);
    await gw.resolve(['mintX']);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('degrades to fallback on a transport failure — never throws', async () => {
    const transport = vi.fn<DasTransport>(async () => {
      throw new Error('boom');
    });
    const m = await make(transport).resolve(['mintErr12345678']);
    expect(m.get('mintErr12345678')?.symbol).toContain('…');
  });
});

import { WebSocket } from 'undici';
import type { WsTransport, WsTransportFactory } from './transaction-stream';

/**
 * Real {@link WsTransport} over undici's WHATWG WebSocket — the ONLY place a live Helius socket is opened,
 * and ONLY when {@link WsTransportFactory} is invoked (which {@link TransactionStream.start} does at runtime,
 * Step 8). Thin + I/O-only: it just forwards the socket's open/message/close/error to the stream and writes
 * frames the stream hands it; ALL no-miss logic (cursor, dedup, replay, gap detection, reconnect) lives in
 * TransactionStream. Deliberately NOT imported by any test — constructing it opens a socket, and a stray
 * Helius connection burns credits.
 */
class HeliusWsTransport implements WsTransport {
  private readonly ws: WebSocket;

  constructor(url: string) {
    // Opening the socket happens HERE, in the constructor — so a transport instance only exists once the
    // stream's factory is invoked at connect time, never at composition/import.
    this.ws = new WebSocket(url);
  }

  onOpen(cb: () => void): void {
    this.ws.addEventListener('open', () => cb());
  }

  onMessage(cb: (data: string) => void): void {
    this.ws.addEventListener('message', (ev) => {
      cb(typeof ev.data === 'string' ? ev.data : String(ev.data));
    });
  }

  onClose(cb: () => void): void {
    this.ws.addEventListener('close', () => cb());
  }

  onError(cb: (err: unknown) => void): void {
    this.ws.addEventListener('error', (ev) => cb(ev));
  }

  send(data: string): void {
    this.ws.send(data);
  }

  ping(): void {
    // The WHATWG WebSocket API (undici / Node's global) exposes no app-level ping frame — that is the `ws`
    // library's extension, which is not a dependency. Liveness is instead guaranteed by the protocol-level
    // server PING that undici auto-PONGs, with the stream's onClose→reconnect + gap detector as the no-miss
    // backstop if the socket ever does die silently. So this keepalive hook is intentionally a no-op.
  }

  close(): void {
    this.ws.close();
  }
}

/** Builds a fresh transport per (re)connect, bound to `url`. Invoked by TransactionStream at connect time. */
export function createHeliusWsTransportFactory(url: string): WsTransportFactory {
  return () => new HeliusWsTransport(url);
}

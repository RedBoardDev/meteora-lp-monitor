import type { EventKind, LiveEvent } from '@meteora/shared';

const BULK_WINDOW_MS = 8000;

export class BulkBuffer {
  private readonly buffers = new Map<EventKind, { events: LiveEvent[]; timer: NodeJS.Timeout }>();
  private seq = 0;

  constructor(private readonly onFlush: (event: LiveEvent) => Promise<void>) {}

  add(event: LiveEvent): void {
    const existing = this.buffers.get(event.kind);
    if (existing) {
      existing.events.push(event);
      return;
    }
    const timer = setTimeout(() => this.flush(event.kind), BULK_WINDOW_MS);
    this.buffers.set(event.kind, { events: [event], timer });
  }

  private flush(kind: EventKind): void {
    const buf = this.buffers.get(kind);
    if (!buf) return;
    this.buffers.delete(kind);
    clearTimeout(buf.timer);
    if (buf.events.length === 1) {
      void this.onFlush(buf.events[0]!);
      return;
    }
    const first = buf.events[0]!;
    void this.onFlush({
      ...first,
      id: `${Date.now()}-${this.seq++}`,
      title: `${buf.events.length} × ${kind.replace(/_/g, ' ')}`,
      body: buf.events.map((e) => e.pair ?? '?').join(', '),
      data: { count: buf.events.length },
    });
  }
}

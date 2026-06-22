type ClientDevice = 'mac' | 'web';

/**
 * Tracks presence from any interactive client (Mac/web) via WebSocket heartbeats. Each
 * client reports `active` based on real presence (foreground, not idle/asleep/locked).
 * Routing: any client active → show native in that app; none active → push to Bark.
 *  - `active:false` expires that device immediately (sleep/lock/background), no timeout wait.
 *  - silent death (crash/quit/network) ages out via the timeout window.
 */
export class PresenceTracker {
  private readonly lastActive = new Map<ClientDevice, number>();

  constructor(private readonly timeoutMs: number) {}

  heartbeat(device: ClientDevice, active: boolean): void {
    this.lastActive.set(device, active ? Date.now() : 0);
  }

  isAnyClientActive(): boolean {
    return this.activeDevices().length > 0;
  }

  /** Devices that reported active within the timeout window (for routing/observability). */
  activeDevices(): ClientDevice[] {
    const now = Date.now();
    const out: ClientDevice[] = [];
    for (const [device, t] of this.lastActive) {
      if (now - t < this.timeoutMs) out.push(device);
    }
    return out;
  }
}

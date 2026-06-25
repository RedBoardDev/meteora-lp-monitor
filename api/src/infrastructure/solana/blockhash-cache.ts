/**
 * Copy-bot — background-refreshed recent blockhash. A blockhash stays valid ~60-90s, so refreshing one every
 * couple of seconds lets the hot path read it instantly instead of paying a `getLatestBlockhash` round-trip
 * (~100ms on WiFi). The brain only needs it to SERIALIZE (the vault re-sets a fresh one before signing), so a
 * slightly-stale cached value is fine there; the vault uses it for the first attempt and re-fetches on retry.
 */
export class BlockhashCache {
  private value: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly fetchFn: () => Promise<string>,
    private readonly refreshMs = 2000,
  ) {}

  /** Prime once (so `get()` is ready) then refresh in the background. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.(); // never keep the process alive just for this
  }

  /** Refresh, keeping the last good value if the fetch fails (transient RPC blip must not blank the cache). */
  async refresh(): Promise<void> {
    try {
      this.value = await this.fetchFn();
    } catch {
      /* keep the previous value */
    }
  }

  /** Latest cached blockhash. Throws if never primed (fail loud rather than serialize with a bogus hash). */
  get(): string {
    if (this.value === undefined) throw new Error('blockhash cache not primed');
    return this.value;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

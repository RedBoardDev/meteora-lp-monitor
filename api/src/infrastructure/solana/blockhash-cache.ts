/**
 * Copy-bot — background-refreshed recent blockhash + its expiry. A blockhash stays valid ~60-90s, so refreshing
 * one every couple of seconds lets the hot path read it instantly instead of paying a `getLatestBlockhash`
 * round-trip (~100ms on WiFi). The brain only needs the blockhash to SERIALIZE (the vault re-sets a fresh one
 * before signing), so a slightly-stale cached value is fine there; the vault uses the pair for the first attempt
 * (and its `lastValidBlockHeight` to record the submitted tx's expiry) and re-fetches on retry.
 */

/** A recent blockhash paired with the block height past which it is provably expired (exactly-once recovery). */
export interface BlockhashInfo {
  blockhash: string;
  lastValidBlockHeight: number;
}

export class BlockhashCache {
  private value: BlockhashInfo | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly fetchFn: () => Promise<BlockhashInfo>,
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

  /** Latest cached blockhash + expiry. Throws if never primed (fail loud rather than serialize with a bogus hash). */
  get(): BlockhashInfo {
    if (this.value === undefined) throw new Error('blockhash cache not primed');
    return this.value;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

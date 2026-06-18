/** Resolve after `ms` milliseconds. The one shared await-able delay (backfill pauses, retry backoff). */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

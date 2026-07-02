// Shared helpers for the on-chain test suite. These were previously re-declared, byte-identically, inline in
// several *.onchain.test.ts files; centralized here as the single source of truth. Behavior is unchanged.

const DEFAULT_POLL_STEP_MS = 2500; // default poll cadence — matches the most common per-file default

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` every `stepMs` until it returns true, or give up after `timeoutMs`. Returns true on success. */
export const pollUntil = async (pred: () => Promise<boolean>, timeoutMs: number, stepMs = DEFAULT_POLL_STEP_MS): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
};

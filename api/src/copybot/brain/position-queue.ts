/**
 * Copy-bot · per-position SERIAL task queue (PURE, no I/O). Guarantees that all work for ONE leader position runs
 * strictly in order: task N+1 only starts after task N has SETTLED (resolved OR rejected). This closes the
 * duplicate-open race — the brain's `onEvent` was firing handlers fire-and-forget, so two events for the SAME
 * leader position ran concurrently and a follow-up add could re-route to a SECOND on-chain open before the first
 * open's `registry.open(...)` had run (real-money double open). Serializing per position makes the follow-up event
 * observe the state left by the prior handler.
 *
 * Different positions run CONCURRENTLY (independent chains) — only same-key work is serialized. A throwing task
 * never blocks its key's next task (the chain awaits SETTLEMENT, not success). The per-key chain entry is dropped
 * when that key's queue drains, so the internal map never grows unbounded.
 */
export interface PositionQueue {
  /** Enqueue `task` on `key`'s serial chain. Fire-and-forget for the caller; internally strictly ordered per key. */
  run(key: string, task: () => Promise<void>): void;
  /** Number of keys with an in-flight/pending chain (test/observability only). */
  size(): number;
}

export function createPositionQueue(): PositionQueue {
  // key → the tail of that key's promise chain. Present only while the key has in-flight/pending work.
  const chains = new Map<string, Promise<void>>();

  const run = (key: string, task: () => Promise<void>): void => {
    const prev = chains.get(key) ?? Promise.resolve();
    // Chain on SETTLEMENT (same handler for fulfil AND reject) so a throwing task does NOT block the key's next
    // task: whether `prev` resolved or rejected, `task` runs next. A `task` that throws (sync or async) rejects
    // `next`, and the following task's reject handler still runs it.
    const next = prev.then(task, task);
    chains.set(key, next);
    // Drop the chain entry once this task settles AND it is still the tail (no newer task enqueued meanwhile) →
    // the map drains to empty when a key goes idle (no unbounded growth). Both settle branches are handled so a
    // rejected `next` never surfaces as an unhandled rejection; task-level errors are the CALLER's concern.
    const drain = (): void => {
      if (chains.get(key) === next) chains.delete(key);
    };
    void next.then(drain, drain);
  };

  return { run, size: () => chains.size };
}

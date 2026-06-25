/**
 * Copy-bot · P2.7 — latency primitives (budget ≤3s, spec 07 §6). External-data filter checks
 * run IN PARALLEL with a hard TIMEOUT, never serially. A check that exceeds the budget → `undefined`
 * (missing data) → the filter skips conservatively (cf. `filters.ts`). No I/O here: we wrap provided
 * promises, so it's testable with fakes/fake timers.
 */

/** Races `p` against a delay `ms`. Returns the value if resolved in time, otherwise `undefined` (timeout OR rejection).
 *  Never propagates an error: a failed/slow check must not take down the decision. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: T | undefined): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish(undefined), ms);
    p.then(
      (v) => finish(v),
      () => finish(undefined),
    );
  });
}

/** Runs all tasks IN PARALLEL, each bounded by `timeoutMs`. Returns one result per task in
 *  order, `undefined` for those that failed/timed out (never a global rejection). A synchronous throw is caught. */
export function runParallel<T>(tasks: Array<() => Promise<T>>, timeoutMs: number): Promise<(T | undefined)[]> {
  return Promise.all(tasks.map((t) => withTimeout(Promise.resolve().then(t), timeoutMs)));
}

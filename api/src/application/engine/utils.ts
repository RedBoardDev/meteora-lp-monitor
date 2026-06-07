const CHUNK = 5;
const CHUNK_GAP_MS = 100;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export async function chunked<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(...(await Promise.all(items.slice(i, i + CHUNK).map(fn))));
    if (i + CHUNK < items.length) await sleep(CHUNK_GAP_MS);
  }
  return out;
}

export function symmetricDiffSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const k of a) if (!b.has(k)) n++;
  for (const k of b) if (!a.has(k)) n++;
  return n;
}

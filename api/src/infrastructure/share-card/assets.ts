import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to `api/assets/share-card` (the PnL-card backgrounds + font).
 *
 * Resolved by walking up from this module so it works both in dev (tsx, run from `src/`) and in
 * prod (the tsup bundle in `dist/`) — the assets live outside the TS sources, so a fixed relative
 * depth would break across those two layouts.
 */
function resolveAssetsDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'assets', 'share-card');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('share-card assets directory not found (expected api/assets/share-card)');
}

const shareCardAssetsDir = resolveAssetsDir();

export const shareCardAsset = (file: string): string => join(shareCardAssetsDir, file);

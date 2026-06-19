import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image.
  output: 'standalone',
  // Monorepo: trace the workspace dependency (@binsight/shared) from the repo root into the bundle.
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;

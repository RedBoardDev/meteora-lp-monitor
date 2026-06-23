import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Defence-in-depth response headers on every route. Deliberately NO script-src/style-src CSP (it would
// risk breaking Next/Tailwind inline assets); the goal here is anti-clickjacking + sniffing hardening:
// the authenticated dashboard (one-click wallet-remove) must not be embeddable in a hostile frame.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

const nextConfig: NextConfig = {
  // Self-contained server for the Docker image.
  output: 'standalone',
  // Monorepo: trace the workspace dependency (@binsight/shared) from the repo root into the bundle.
  outputFileTracingRoot: repoRoot,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

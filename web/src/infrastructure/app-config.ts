/**
 * Server-only: read the backend's public feature flags (`/config/app`). Used by the server components
 * (home + login) to drive the open-access UI. Defaults to the SECURE behavior (openAccess: false) when
 * the API is unreachable, so the UI never exposes the simplified signup while the backend isn't in
 * open mode.
 */

import { API_URL } from './config';

export async function getOpenAccess(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/config/app`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { openAccess?: boolean };
    return data.openAccess === true;
  } catch {
    return false;
  }
}

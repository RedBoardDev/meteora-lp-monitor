/**
 * Server-only configuration constants. Imported exclusively by route handlers under `app/api/**`.
 * `API_URL` is intentionally NOT a `NEXT_PUBLIC_` var, so it is never inlined into the client bundle.
 * (Auth-flow orchestration lives in `auth-flow.ts` — this file holds only constants.)
 */

/** Backend API base URL (server-side only — never exposed to the browser). */
export const API_URL = process.env.API_URL ?? 'http://localhost:8787';

export const SESSION_COOKIE = 'mlpm_session';

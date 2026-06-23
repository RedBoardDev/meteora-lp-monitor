/**
 * Server-only auth-flow orchestration: forwards the SIWS/login/reset challenges to the backend and
 * (for a session) sets the httpOnly cookie. Kept out of config.ts so that file is pure constants.
 * Imported exclusively by the `app/api/auth/**` route handlers.
 */

import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from './config';

function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/**
 * Auth proxy that establishes a session: forwards `body` to `<API_URL><upstreamPath>`; on a non-OK
 * upstream passes the error straight through (status preserved, `fallbackError` when none given);
 * on success reads `{ token, expiresInSeconds }`, sets the httpOnly session cookie and returns
 * `{ ok: true }`. Used by login / register / reset.
 */
export async function forwardAuthSession(
  upstreamPath: string,
  body: unknown,
  fallbackError: string,
): Promise<NextResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${upstreamPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000), // a hung backend must not leak a connection for ~300s
    });
  } catch {
    return NextResponse.json({ error: fallbackError }, { status: 502 });
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return NextResponse.json({ error: data.error ?? fallbackError }, { status: res.status });
  }
  const parsed = (await res.json().catch(() => null)) as {
    token?: string;
    expiresInSeconds?: number;
  } | null;
  if (!parsed?.token || typeof parsed.expiresInSeconds !== 'number') {
    return NextResponse.json({ error: fallbackError }, { status: 502 });
  }
  (await cookies()).set(
    SESSION_COOKIE,
    parsed.token,
    sessionCookieOptions(parsed.expiresInSeconds),
  );
  return NextResponse.json({ ok: true });
}

/**
 * Body-passthrough auth proxy (no cookie): forwards `body` to `<API_URL><upstreamPath>` and passes
 * the JSON response straight through with the upstream status. Used by the nonce challenge routes.
 */
export async function forwardAuthPassthrough(
  upstreamPath: string,
  body: unknown,
): Promise<NextResponse> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${upstreamPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return NextResponse.json({ error: 'upstream unavailable' }, { status: 502 });
  }
  const data = (await res.json().catch(() => ({}))) as unknown;
  return NextResponse.json(data, { status: res.status });
}

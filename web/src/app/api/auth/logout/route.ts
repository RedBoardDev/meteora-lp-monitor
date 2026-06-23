import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/infrastructure/config';

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  // Revoke the backend session (deletes its jti) so the JWT can't be replayed within its TTL — clearing
  // the cookie alone leaves the jti allow-listed. Best-effort + timeout: the local logout must always
  // succeed even if the backend is slow/down, so failures here are intentionally non-fatal.
  if (token) {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
  jar.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}

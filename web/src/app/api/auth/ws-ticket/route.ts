import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/infrastructure/config';

/**
 * Mints a short-lived WebSocket ticket from the backend using the httpOnly session JWT, so the
 * long-lived session token never reaches client-side JS — only the ephemeral ticket does.
 */
export async function GET() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const res = await fetch(`${API_URL}/auth/ws-ticket`, {
    headers: { authorization: `Bearer ${session}` },
  });
  if (!res.ok) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  const { token } = (await res.json()) as { token: string };
  return NextResponse.json({ token });
}

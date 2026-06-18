import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';
import { API_URL, SESSION_COOKIE } from '@/infrastructure/config';

type Context = { params: Promise<{ path: string[] }> };

/**
 * BFF proxy: forwards every `/api/<path>` call to the backend `<API_URL>/<path>`,
 * attaching the session JWT (httpOnly cookie) as a Bearer token. The browser never
 * sees the token. Auth routes (`/api/auth/*`) are handled by their own explicit
 * handlers and never reach this catch-all.
 */
async function proxy(request: NextRequest, { params }: Context): Promise<Response> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) {
    return Response.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const { path } = await params;
  // Reject path-traversal / empty segments so the proxy can only reach intended API paths.
  if (path.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return Response.json({ error: 'bad request' }, { status: 400 });
  }
  const target = `${API_URL}/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let body: string | undefined;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = await request.text();
    // Only forward a body + content-type when there actually IS one. A no-body POST/DELETE (removing a
    // wallet or a whitelist entry) must NOT carry `content-type: application/json`, or Fastify rejects
    // it with "Body cannot be empty when content-type is set to 'application/json'".
    if (raw.length > 0) {
      body = raw;
      headers['content-type'] = request.headers.get('content-type') ?? 'application/json';
    }
  }

  const upstream = await fetch(target, { method: request.method, headers, body });
  // A rejected session token is dead — clear the cookie so the next navigation lands on /login.
  if (upstream.status === 401) cookieStore.delete(SESSION_COOKIE);
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;

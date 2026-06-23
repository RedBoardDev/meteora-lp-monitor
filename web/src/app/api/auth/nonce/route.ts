import { forwardAuthPassthrough } from '@/infrastructure/auth-flow';

// Register step 1: ask the backend for a single-use challenge for `address`. No cookie is set; the
// response ({ nonce, message } on success, or { notWhitelisted } on 403) is passed straight through.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { address?: string };
  return forwardAuthPassthrough('/auth/nonce', { address: body.address ?? '' });
}

import { forwardAuthPassthrough } from '@/infrastructure/auth-flow';

// Password-reset step 1: a challenge for any valid address (the backend never reveals whether the
// account exists). No cookie; the response ({ nonce, message }) is passed straight through.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { address?: string };
  return forwardAuthPassthrough('/auth/reset/nonce', { address: body.address ?? '' });
}

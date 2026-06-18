import { forwardAuthSession } from '@/infrastructure/config';

// Password-reset step 2: prove wallet ownership + set a new password. On success the backend returns a
// fresh session token (carrying the bumped version, so old sessions are dead) — log the user straight in.
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    address?: string;
    signature?: string;
    nonce?: string;
    password?: string;
  };
  return forwardAuthSession(
    '/auth/reset',
    {
      address: body.address ?? '',
      signature: body.signature ?? '',
      nonce: body.nonce ?? '',
      password: body.password ?? '',
    },
    'reset failed',
  );
}

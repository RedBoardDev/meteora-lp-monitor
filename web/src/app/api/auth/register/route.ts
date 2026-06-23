import { forwardAuthSession } from '@/infrastructure/auth-flow';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    address?: string;
    signature?: string;
    nonce?: string;
    password?: string;
  };
  return forwardAuthSession(
    '/auth/register',
    {
      address: body.address ?? '',
      signature: body.signature ?? '',
      nonce: body.nonce ?? '',
      password: body.password ?? '',
    },
    'registration failed',
  );
}

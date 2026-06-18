import { forwardAuthSession } from '@/infrastructure/config';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    address?: string;
    password?: string;
  };
  return forwardAuthSession(
    '/auth/login',
    { address: body.address ?? '', password: body.password ?? '' },
    'invalid address or password',
  );
}

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getOpenAccess } from '@/infrastructure/app-config';
import { API_URL, SESSION_COOKIE } from '@/infrastructure/config';
import { Dashboard } from '@/presentation/components/dashboard';

export default async function Home() {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) redirect('/login');
  // Gate on a VALID token (signature + expiry), not just cookie presence — the backend verifies it.
  const res = await fetch(`${API_URL}/auth/verify`, {
    headers: { authorization: `Bearer ${session}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) redirect('/login');
  const openAccess = await getOpenAccess();
  return <Dashboard openAccess={openAccess} />;
}

import { getOpenAccess } from '@/infrastructure/app-config';
import { LoginClient } from './login-client';

export default async function LoginPage() {
  // Read open-access from the backend server-side so the signup UI is correct on first paint (no flash
  // between the SIWS flow and the simplified address + password form).
  const openAccess = await getOpenAccess();
  return <LoginClient openAccess={openAccess} />;
}

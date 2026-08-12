import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';

export default async function RootPage() {
  const me = await getServerSession();

  if (!me.authenticated) redirect('/sign-in');
  if (!me.mfaSatisfied) redirect('/mfa');
  redirect('/home');
}

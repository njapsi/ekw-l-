import type { Metadata } from 'next';
import { requireActiveOrg } from '@/lib/auth';
import { NotificationsView } from '@/components/app/notifications-view';

export const metadata: Metadata = { title: 'Notifications' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  // Auth + active-org gate (the data itself is loaded client-side via
  // /api/notifications, which re-checks the session).
  await requireActiveOrg();
  return <NotificationsView />;
}

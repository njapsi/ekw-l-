import type { ReactNode } from 'react';
import Link from 'next/link';
import { requirePlatformStaff } from '@/lib/auth';
import { AdminNav } from '@/components/admin/admin-nav';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requirePlatformStaff();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-border flex h-14 items-center gap-4 border-b px-4">
        <Link href="/admin" className="font-semibold">
          Growth Agent · Admin
        </Link>
        <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          platform staff
        </span>
        <div className="text-muted-foreground ml-auto text-sm">{user.email}</div>
        <Link href="/app" className="text-sm underline">
          Back to app
        </Link>
      </header>
      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-6 px-4 py-6">
        <aside className="w-44 shrink-0">
          <AdminNav />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}

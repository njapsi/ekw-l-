'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X } from 'lucide-react';
import { Button, cn } from '@growth-agent/ui';
import { APP_NAV } from './nav';
import { NotificationBell } from './notification-bell';
import { OrgSwitcher, type OrgOption } from './org-switcher';
import { UserMenu } from './user-menu';

export interface AppShellProps {
  user: { name: string | null; email: string; image: string | null; isPlatformStaff: boolean };
  organizations: OrgOption[];
  activeOrgId: string;
  children: React.ReactNode;
}

export function AppShell({ user, organizations, activeOrgId, children }: AppShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navList = (
    <nav className="flex flex-col gap-1 p-3">
      {APP_NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
      {user.isPlatformStaff ? (
        <Link
          href="/admin"
          onClick={() => setMobileOpen(false)}
          className="text-muted-foreground hover:bg-muted hover:text-foreground mt-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm"
        >
          Admin
        </Link>
      ) : null}
    </nav>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-border bg-background sticky top-0 z-40 flex h-14 items-center gap-3 border-b px-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
        <Link href="/app/dashboard" className="flex items-center gap-2 font-semibold">
          <span className="bg-primary inline-block size-5 rounded" aria-hidden />
          <span className="hidden sm:inline">Growth Agent</span>
        </Link>
        <div className="ml-auto flex items-center gap-2">
          <NotificationBell />
          <OrgSwitcher organizations={organizations} activeOrgId={activeOrgId} />
          <UserMenu name={user.name} email={user.email} image={user.image} />
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="border-border hidden w-60 shrink-0 border-r lg:block">{navList}</aside>

        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setMobileOpen(false)}
              aria-hidden
            />
            <div className="border-border bg-background absolute left-0 top-0 h-full w-64 border-r">
              <div className="flex h-14 items-center justify-between px-4">
                <span className="font-semibold">Menu</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close navigation"
                >
                  <X className="size-5" />
                </Button>
              </div>
              {navList}
            </div>
          </div>
        ) : null}

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-5xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

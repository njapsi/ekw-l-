'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@growth-agent/ui';

export interface SettingsNavItem {
  href: string;
  label: string;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export function SettingsNav({ groups }: { groups: SettingsNavGroup[] }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-6 overflow-x-auto md:flex-col md:gap-5">
      {groups.map((g) => (
        <div key={g.label} className="flex min-w-max gap-1 md:flex-col">
          <p className="text-muted-foreground hidden px-3 pb-1 text-xs font-medium uppercase tracking-wide md:block">
            {g.label}
          </p>
          {g.items.map((item) => {
            const active =
              item.href === '/app/settings'
                ? pathname === item.href
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'rounded-md px-3 py-1.5 text-sm transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@growth-agent/ui';

const TABS = [
  ['/app/youtube/overview', 'Overview'],
  ['/app/youtube/performance', 'Performance'],
  ['/app/youtube/videos', 'Videos'],
  ['/app/youtube/growth', 'Growth'],
  ['/app/youtube/opportunities', 'Content opportunities'],
  ['/app/youtube/calendar', 'Calendar'],
  ['/app/youtube/experiments', 'Experiments'],
  ['/app/youtube/monetization', 'Monetization'],
  ['/app/youtube/recommendations', 'Recommendations'],
] as const;

export function YouTubeTabs() {
  const pathname = usePathname();
  return (
    <div className="border-border -mb-px flex gap-1 overflow-x-auto border-b">
      {TABS.map(([href, label]) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors',
              active
                ? 'border-primary text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground border-transparent',
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

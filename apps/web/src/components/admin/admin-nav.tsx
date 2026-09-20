'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@growth-agent/ui';

const SECTIONS: { href: string; label: string }[] = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/organizations', label: 'Organizations' },
  { href: '/admin/subscriptions', label: 'Subscriptions' },
  { href: '/admin/usage', label: 'Usage' },
  { href: '/admin/ai-usage', label: 'AI usage' },
  { href: '/admin/agent-runs', label: 'Agent runs' },
  { href: '/admin/crawler-jobs', label: 'Crawler jobs' },
  { href: '/admin/integrations', label: 'API integrations' },
  { href: '/admin/mcp-servers', label: 'MCP servers' },
  { href: '/admin/errors', label: 'Errors' },
  { href: '/admin/audit-logs', label: 'Audit logs' },
  { href: '/admin/system-health', label: 'System health' },
  { href: '/admin/jobs', label: 'Background jobs' },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-0.5 text-sm">
      {SECTIONS.map((s) => {
        const active = s.href === '/admin' ? pathname === '/admin' : pathname.startsWith(s.href);
        return (
          <Link
            key={s.href}
            href={s.href}
            className={cn(
              'rounded px-3 py-1.5 transition-colors',
              active
                ? 'bg-muted text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
            )}
          >
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}

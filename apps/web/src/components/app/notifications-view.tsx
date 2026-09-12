'use client';

import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, EmptyState, PageHeader, cn } from '@growth-agent/ui';

interface NotificationRow {
  id: string;
  kind: string;
  level: 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string;
  linkPath: string | null;
  readAt: string | null;
  createdAt: string;
}

const LEVEL_DOT: Record<NotificationRow['level'], string> = {
  INFO: 'bg-muted-foreground',
  SUCCESS: 'bg-emerald-500',
  WARNING: 'bg-amber-500',
  CRITICAL: 'bg-destructive',
};

async function fetchAll(): Promise<{ unread: number; items: NotificationRow[] }> {
  const res = await fetch('/api/notifications?limit=100', { cache: 'no-store' });
  if (!res.ok) throw new Error('failed to load notifications');
  return res.json() as Promise<{ unread: number; items: NotificationRow[] }>;
}

export function NotificationsView() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ['notifications', 'all'],
    queryFn: fetchAll,
    refetchInterval: 60_000,
  });

  async function post(body: unknown) {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    await qc.invalidateQueries({ queryKey: ['notifications'] });
  }

  const items = data?.items ?? [];
  const unread = data?.unread ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Notifications"
        description="Events from your crawls, reports, automations and team."
        actions={
          unread > 0 ? (
            <Button size="sm" variant="outline" onClick={() => void post({ all: true })}>
              Mark all read ({unread})
            </Button>
          ) : undefined
        }
      />

      {isLoading ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading…
        </p>
      ) : isError ? (
        <p role="alert" className="text-destructive text-sm">
          Could not load notifications. Try refreshing.
        </p>
      ) : items.length === 0 ? (
        <EmptyState
          title="You're all caught up"
          description="New notifications appear here when a crawl finishes, a report is ready, or an automation needs attention."
        />
      ) : (
        <ul className="border-border divide-border divide-y overflow-hidden rounded-lg border">
          {items.map((n) => {
            const inner = (
              <div className="flex gap-3 px-4 py-3">
                <span
                  className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    n.readAt ? 'bg-transparent' : LEVEL_DOT[n.level],
                  )}
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className={cn('truncate text-sm', n.readAt || 'font-medium')}>{n.title}</p>
                    <time className="text-muted-foreground shrink-0 text-xs">
                      {new Date(n.createdAt).toLocaleString()}
                    </time>
                  </div>
                  <p className="text-muted-foreground text-sm">{n.body}</p>
                </div>
              </div>
            );
            return (
              <li key={n.id} className={cn(!n.readAt && 'bg-muted/30')}>
                {n.linkPath ? (
                  <Link
                    href={n.linkPath}
                    onClick={() => void post({ ids: [n.id] })}
                    className="hover:bg-muted block"
                  >
                    {inner}
                  </Link>
                ) : (
                  <button
                    type="button"
                    onClick={() => void post({ ids: [n.id] })}
                    className="hover:bg-muted block w-full text-left"
                  >
                    {inner}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

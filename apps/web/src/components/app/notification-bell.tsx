'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { cn } from '@growth-agent/ui';

interface NotificationRow {
  id: string;
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

async function fetchNotifications(): Promise<{ unread: number; items: NotificationRow[] }> {
  const res = await fetch('/api/notifications?limit=10', { cache: 'no-store' });
  if (!res.ok) throw new Error('failed to load notifications');
  return res.json() as Promise<{ unread: number; items: NotificationRow[] }>;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: fetchNotifications,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  async function markAll() {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  }

  async function markOne(id: string) {
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: [id] }),
    });
    void qc.invalidateQueries({ queryKey: ['notifications'] });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="hover:bg-muted focus-visible:ring-ring relative inline-flex size-9 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2"
      >
        <Bell className="size-5" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="bg-destructive text-destructive-foreground absolute -right-0.5 -top-0.5 min-w-4 rounded-full px-1 text-[10px] font-semibold leading-4"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          className="border-border bg-background absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-md border shadow-lg"
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 ? (
              <button
                type="button"
                onClick={markAll}
                className="text-muted-foreground hover:text-foreground text-xs"
              >
                Mark all read
              </button>
            ) : null}
          </div>
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.length === 0 ? (
              <li className="text-muted-foreground px-3 py-6 text-center text-sm">
                You&apos;re all caught up.
              </li>
            ) : (
              items.map((n) => {
                const content = (
                  <div className="flex gap-2">
                    <span
                      className={cn(
                        'mt-1.5 size-1.5 shrink-0 rounded-full',
                        n.readAt ? 'bg-transparent' : LEVEL_DOT[n.level],
                      )}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className={cn('truncate text-sm', n.readAt || 'font-medium')}>{n.title}</p>
                      <p className="text-muted-foreground line-clamp-2 text-xs">{n.body}</p>
                    </div>
                  </div>
                );
                return (
                  <li key={n.id}>
                    {n.linkPath ? (
                      <Link
                        href={n.linkPath}
                        onClick={() => {
                          void markOne(n.id);
                          setOpen(false);
                        }}
                        className="hover:bg-muted block px-3 py-2"
                      >
                        {content}
                      </Link>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void markOne(n.id)}
                        className="hover:bg-muted block w-full px-3 py-2 text-left"
                      >
                        {content}
                      </button>
                    )}
                  </li>
                );
              })
            )}
          </ul>
          <div className="border-t px-3 py-2 text-center">
            <Link
              href="/app/notifications"
              onClick={() => setOpen(false)}
              className="text-primary text-xs hover:underline"
            >
              View all
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

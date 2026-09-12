'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button, Input } from '@growth-agent/ui';
import { deleteConversationAction, renameConversationAction } from '@/server/agent-actions';

interface ConvoItem {
  id: string;
  title: string;
  lastMessageAt: string | Date;
}

export function ConversationSidebar({ conversations }: { conversations: ConvoItem[] }) {
  const router = useRouter();
  const activeId = usePathname().split('/app/agent/')[1]?.split('/')[0];
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{
    id: string;
    title: string;
    snippet: string;
  }> | null>(null);
  const [searching, startSearch] = useTransition();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const runSearch = (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    startSearch(async () => {
      const res = await fetch(`/api/agent/search?q=${encodeURIComponent(q)}`).catch(() => null);
      if (res?.ok)
        setResults((await res.json()) as Array<{ id: string; title: string; snippet: string }>);
    });
  };

  const list = results ?? conversations.map((c) => ({ id: c.id, title: c.title, snippet: '' }));

  return (
    <div className="flex h-full flex-col gap-2">
      <Button asChild size="sm" className="w-full">
        <Link href="/app/agent">+ New conversation</Link>
      </Button>
      <Input
        value={query}
        onChange={(e) => runSearch(e.target.value)}
        placeholder="Search conversations…"
        className="h-8 text-sm"
      />
      <ul className="flex-1 space-y-1 overflow-y-auto text-sm">
        {list.length === 0 ? (
          <li className="text-muted-foreground px-1 py-2 text-xs">
            {searching ? 'Searching…' : query ? 'No matches.' : 'No conversations yet.'}
          </li>
        ) : (
          list.map((c) => (
            <li
              key={c.id}
              className={`group rounded px-2 py-1.5 ${c.id === activeId ? 'bg-muted' : 'hover:bg-muted/60'}`}
            >
              {editingId === c.id ? (
                <form
                  className="flex gap-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void renameConversationAction(c.id, editTitle).then(() => {
                      setEditingId(null);
                      router.refresh();
                    });
                  }}
                >
                  <Input
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="h-7 text-xs"
                    autoFocus
                  />
                  <Button type="submit" size="sm" variant="ghost">
                    Save
                  </Button>
                </form>
              ) : (
                <div className="flex items-center justify-between gap-1">
                  <Link href={`/app/agent/${c.id}`} className="min-w-0 flex-1 truncate">
                    {c.title}
                    {c.snippet ? (
                      <span className="text-muted-foreground block truncate text-xs">
                        {c.snippet}
                      </span>
                    ) : null}
                  </Link>
                  <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                    <button
                      type="button"
                      title="Rename"
                      className="text-muted-foreground hover:text-foreground px-1 text-xs"
                      onClick={() => {
                        setEditingId(c.id);
                        setEditTitle(c.title);
                      }}
                    >
                      ✎
                    </button>
                    <a
                      href={`/api/agent/conversations/${c.id}/export`}
                      title="Export (Markdown)"
                      className="text-muted-foreground hover:text-foreground px-1 text-xs"
                    >
                      ↓
                    </a>
                    <button
                      type="button"
                      title="Delete"
                      className="text-muted-foreground hover:text-destructive px-1 text-xs"
                      onClick={() => {
                        if (!confirm('Delete this conversation?')) return;
                        void deleteConversationAction(c.id).then(() => {
                          if (c.id === activeId) router.push('/app/agent');
                          router.refresh();
                        });
                      }}
                    >
                      ✕
                    </button>
                  </span>
                </div>
              )}
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

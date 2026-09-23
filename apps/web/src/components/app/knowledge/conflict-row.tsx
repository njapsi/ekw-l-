'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@growth-agent/ui';
import { resolveConflictAction } from '@/server/knowledge-actions';

export interface ConflictRowData {
  id: string;
  topic: string;
  knowledgeA: { id: string; title: string; content: string };
  knowledgeB: { id: string; title: string; content: string };
}

export function ConflictRow({ conflict }: { conflict: ConflictRowData }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(keepKnowledgeId?: string, dismiss = false) {
    setPending(true);
    setError(null);
    const result = await resolveConflictAction(conflict.id, {
      resolution: keepKnowledgeId
        ? `Kept "${keepKnowledgeId === conflict.knowledgeA.id ? conflict.knowledgeA.title : conflict.knowledgeB.title}".`
        : 'Both are correct in their own context — no single item was rejected.',
      keepKnowledgeId,
      status: dismiss ? 'DISMISSED' : 'RESOLVED',
    });
    setPending(false);
    if (!result.ok) {
      setError(result.error ?? 'Something went wrong.');
      return;
    }
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{conflict.topic}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="border-border space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{conflict.knowledgeA.title}</p>
            <p className="text-muted-foreground line-clamp-3 text-sm">{conflict.knowledgeA.content}</p>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void resolve(conflict.knowledgeA.id)}>
              Keep this one
            </Button>
          </div>
          <div className="border-border space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{conflict.knowledgeB.title}</p>
            <p className="text-muted-foreground line-clamp-3 text-sm">{conflict.knowledgeB.content}</p>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => void resolve(conflict.knowledgeB.id)}>
              Keep this one
            </Button>
          </div>
        </div>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => void resolve(undefined, false)}>
          Both are correct (clear conflict)
        </Button>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

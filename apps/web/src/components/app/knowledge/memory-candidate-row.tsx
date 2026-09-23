'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, CardContent } from '@growth-agent/ui';
import { acceptMemoryCandidateAction, rejectMemoryCandidateAction } from '@/server/knowledge-actions';

export interface MemoryCandidateRowData {
  id: string;
  content: string;
  proposedType: string;
  reason: string;
  importance: string;
  confidence: number;
}

export function MemoryCandidateRow({ candidate }: { candidate: MemoryCandidateRowData }) {
  const router = useRouter();
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(action: 'accept' | 'reject') {
    setPending(action);
    setError(null);
    const result =
      action === 'accept'
        ? await acceptMemoryCandidateAction(candidate.id)
        : await rejectMemoryCandidateAction(candidate.id);
    setPending(null);
    if (!result.ok) {
      setError(result.error ?? 'Something went wrong.');
      return;
    }
    router.refresh();
  }

  return (
    <Card>
      <CardContent className="space-y-3 pt-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{candidate.proposedType.replace(/_/g, ' ').toLowerCase()}</Badge>
          <Badge variant="outline">{candidate.importance.toLowerCase()} importance</Badge>
          <Badge variant="outline">{Math.round(candidate.confidence * 100)}% confidence</Badge>
        </div>
        <p className="text-sm">{candidate.content}</p>
        <p className="text-muted-foreground text-xs">{candidate.reason}</p>
        <div className="flex gap-2">
          <Button size="sm" disabled={pending !== null} onClick={() => void run('accept')}>
            {pending === 'accept' ? 'Saving…' : 'Accept'}
          </Button>
          <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void run('reject')}>
            {pending === 'reject' ? 'Rejecting…' : 'Reject'}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

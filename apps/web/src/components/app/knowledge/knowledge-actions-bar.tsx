'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  archiveKnowledgeItemAction,
  deleteKnowledgeItemAction,
  verifyKnowledgeItemAction,
} from '@/server/knowledge-actions';

export function KnowledgeActionsBar({ knowledgeId, status }: { knowledgeId: string; status: string }) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(action: 'verify' | 'archive' | 'delete') {
    setPending(action);
    setError(null);
    const result =
      action === 'verify'
        ? await verifyKnowledgeItemAction(knowledgeId)
        : action === 'archive'
          ? await archiveKnowledgeItemAction(knowledgeId)
          : await deleteKnowledgeItemAction(knowledgeId);
    setPending(null);
    if (!result.ok) {
      setError(result.error ?? 'Something went wrong.');
      return;
    }
    if (action === 'delete') {
      router.push('/app/knowledge');
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {status !== 'VERIFIED' && status !== 'ARCHIVED' && status !== 'REJECTED' ? (
          <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void run('verify')}>
            {pending === 'verify' ? 'Marking…' : 'Mark verified'}
          </Button>
        ) : null}
        {status !== 'ARCHIVED' ? (
          <Button size="sm" variant="outline" disabled={pending !== null} onClick={() => void run('archive')}>
            {pending === 'archive' ? 'Archiving…' : 'Archive'}
          </Button>
        ) : null}
        {confirmDelete ? (
          <Button size="sm" variant="destructive" disabled={pending !== null} onClick={() => void run('delete')}>
            {pending === 'delete' ? 'Deleting…' : 'Confirm delete'}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

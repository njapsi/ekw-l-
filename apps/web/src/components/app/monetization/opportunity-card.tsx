'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button } from '@growth-agent/ui';
import {
  promoteOpportunityToTaskAction,
  updateOpportunityStatusAction,
} from '@/server/monetization-actions';
import { channelLabel } from './channels';

export interface OpportunityView {
  id: string;
  channel: string;
  title: string;
  description: string;
  status: 'SUGGESTED' | 'IN_PROGRESS' | 'ACTIVE' | 'COMPLETED' | 'DISMISSED';
  evidence: Array<{ statement: string; kind: string }>;
  audienceFit: string;
  difficulty: string;
  potential: string;
  potentialBasis: string;
  requiredActions: string[];
  confidence: number;
  isEstimate: boolean;
  priorityScore: number | null;
  dismissedReason: string | null;
  completedNote: string | null;
}

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  SUGGESTED: 'outline',
  IN_PROGRESS: 'secondary',
  ACTIVE: 'secondary',
  COMPLETED: 'secondary',
  DISMISSED: 'destructive',
};

export function OpportunityCard({ opp }: { opp: OpportunityView }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done') : (r.error ?? 'Failed') });
      if (r.ok) router.refresh();
    });

  const setStatus = (status: OpportunityView['status'], reason?: string) =>
    run(() => updateOpportunityStatusAction(opp.id, status, reason));

  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[opp.status] ?? 'outline'}>
              {opp.status.toLowerCase().replace('_', ' ')}
            </Badge>
            <Badge variant="outline">{channelLabel(opp.channel)}</Badge>
            {opp.priorityScore != null ? (
              <span className="text-muted-foreground text-xs">
                priority {opp.priorityScore}/100
              </span>
            ) : null}
          </div>
          <h3 className="mt-1 text-sm font-medium">{opp.title}</h3>
        </div>
      </div>

      <p className="text-muted-foreground mt-2 text-sm">{opp.description}</p>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          <span className="text-muted-foreground">Audience fit: </span>
          {opp.audienceFit}
        </span>
        <span>
          <span className="text-muted-foreground">Est. difficulty: </span>
          {opp.difficulty}
        </span>
        <span>
          <span className="text-muted-foreground">Est. potential: </span>
          {opp.potential}
          {opp.isEstimate ? ' (estimate)' : ''}
        </span>
        <span>
          <span className="text-muted-foreground">Confidence: </span>
          {Math.round(opp.confidence * 100)}%
        </span>
      </div>

      <p className="text-muted-foreground mt-2 text-xs italic">{opp.potentialBasis}</p>

      {opp.requiredActions.length ? (
        <div className="mt-3">
          <p className="text-xs font-medium">Required actions</p>
          <ol className="text-muted-foreground mt-1 list-decimal space-y-0.5 pl-4 text-xs">
            {opp.requiredActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        </div>
      ) : null}

      {opp.evidence.length ? (
        <div className="mt-3">
          <button
            type="button"
            className="text-xs underline"
            onClick={() => setShowEvidence((v) => !v)}
          >
            {showEvidence ? 'Hide' : 'Show'} evidence ({opp.evidence.length})
          </button>
          {showEvidence ? (
            <ul className="text-muted-foreground mt-1 space-y-0.5 text-xs">
              {opp.evidence.map((e, i) => (
                <li key={i}>
                  <span className="uppercase">[{e.kind}]</span> {e.statement}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {opp.dismissedReason ? (
        <p className="text-muted-foreground mt-2 text-xs">Dismissed: {opp.dismissedReason}</p>
      ) : null}
      {opp.completedNote ? (
        <p className="text-muted-foreground mt-2 text-xs">Note: {opp.completedNote}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {opp.status === 'SUGGESTED' ? (
          <Button size="sm" disabled={pending} onClick={() => setStatus('IN_PROGRESS')}>
            Start
          </Button>
        ) : null}
        {(opp.status === 'SUGGESTED' ||
          opp.status === 'IN_PROGRESS' ||
          opp.status === 'ACTIVE') && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => run(() => promoteOpportunityToTaskAction(opp.id))}
            >
              Create task
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setStatus('COMPLETED')}
            >
              Mark complete
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={pending}
              onClick={() => {
                const reason =
                  window.prompt('Why are you dismissing this? (optional)') ?? undefined;
                setStatus('DISMISSED', reason);
              }}
            >
              Dismiss
            </Button>
          </>
        )}
        {opp.status === 'COMPLETED' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setStatus('IN_PROGRESS')}
          >
            Reopen
          </Button>
        ) : null}
        {opp.status === 'DISMISSED' ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => setStatus('SUGGESTED')}
          >
            Restore
          </Button>
        ) : null}
      </div>

      {msg ? (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`mt-2 text-xs ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}

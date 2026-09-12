'use client';

import { useState, useTransition } from 'react';
import { Badge, Button } from '@growth-agent/ui';
import { createAdHocTaskAction } from '@/server/agent-actions';

export interface AgentRecommendationBlock {
  title: string;
  problem: string;
  whyItMatters: string;
  howToFix: string;
  expectedBenefit: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  difficulty: 'trivial' | 'small' | 'medium' | 'large';
  confidence: number;
  domain: string;
  affectedUrls: string[];
  affectedRefs: string[];
  evidenceRefs: string[];
}

export interface AgentBlocks {
  analysisSummary: string;
  evidence: Array<{ source: string; statement: string; kind: string }>;
  decisions: string[];
  recommendations: AgentRecommendationBlock[];
  proposedActions: Array<{
    kind: 'create_task' | 'external';
    label: string;
    recommendationIndex?: number;
    requiresConfirmation: boolean;
    note?: string;
  }>;
  disclaimers: string[];
}

const PRIORITY_VARIANT: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  critical: 'destructive',
  high: 'destructive',
  medium: 'secondary',
  low: 'outline',
};

export function MessageBlocks({
  blocks,
  conversationId,
}: {
  blocks: AgentBlocks;
  conversationId?: string;
}) {
  return (
    <div className="mt-3 space-y-4 border-t pt-3 text-sm">
      {blocks.decisions.length > 0 ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide">What I did</h4>
          <ul className="text-muted-foreground mt-1 list-disc pl-5">
            {blocks.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {blocks.recommendations.length > 0 ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide">Recommendations</h4>
          <ul className="mt-1 space-y-3">
            {blocks.recommendations.map((r, i) => (
              <li key={i} className="bg-muted/40 rounded-md p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={PRIORITY_VARIANT[r.priority] ?? 'secondary'}>{r.priority}</Badge>
                  <span className="text-muted-foreground text-xs">
                    {r.domain} · {r.difficulty} effort · conf {Math.round(r.confidence * 100)}%
                  </span>
                </div>
                <p className="mt-1 font-medium">{r.title}</p>
                <p className="text-muted-foreground">
                  <span className="font-medium">Why it matters:</span> {r.whyItMatters}
                </p>
                <p className="text-xs">
                  <span className="font-medium">How to fix:</span> {r.howToFix}
                </p>
                <p className="text-muted-foreground text-xs">
                  <span className="font-medium">Expected benefit:</span> {r.expectedBenefit}
                </p>
                {r.affectedUrls.length > 0 ? (
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {r.affectedUrls.slice(0, 4).join(' · ')}
                  </p>
                ) : null}
                <div className="mt-2">
                  <CreateTaskButton conversationId={conversationId} recommendation={r} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {blocks.proposedActions.some((a) => a.kind === 'external') ? (
        <section>
          <h4 className="text-xs font-semibold uppercase tracking-wide">
            Actions that need confirmation
          </h4>
          <ul className="text-muted-foreground mt-1 list-disc pl-5">
            {blocks.proposedActions
              .filter((a) => a.kind === 'external')
              .map((a, i) => (
                <li key={i}>
                  {a.label}. {a.note}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {blocks.evidence.length > 0 ? (
        <details className="text-muted-foreground text-xs">
          <summary className="cursor-pointer">Evidence ({blocks.evidence.length})</summary>
          <ul className="mt-1 list-disc pl-5">
            {blocks.evidence.map((e, i) => (
              <li key={i}>
                <span className="font-mono">[{e.kind}]</span> {e.statement}{' '}
                <span className="opacity-60">— {e.source}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {blocks.disclaimers.length > 0 ? (
        <ul className="text-muted-foreground list-disc pl-5 text-xs">
          {blocks.disclaimers.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CreateTaskButton({
  conversationId,
  recommendation,
}: {
  conversationId?: string;
  recommendation: AgentRecommendationBlock;
}) {
  const [pending, start] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending || Boolean(done)}
        onClick={() =>
          start(async () => {
            const r = await createAdHocTaskAction({
              title: recommendation.title,
              instructions: `${recommendation.howToFix}\n\nWhy it matters: ${recommendation.whyItMatters}\nExpected benefit: ${recommendation.expectedBenefit}`,
              priority: recommendation.priority,
              affectedUrls: recommendation.affectedUrls,
              conversationId,
            });
            setDone(r.ok ? 'Task created' : (r.error ?? 'Failed'));
          })
        }
      >
        {pending ? 'Creating…' : (done ?? 'Create task')}
      </Button>
    </span>
  );
}

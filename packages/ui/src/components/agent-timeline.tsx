import { Check, Loader2 } from 'lucide-react';
import { cn } from '../lib/cn.js';

export interface AgentTimelineStep {
  id: string;
  label: string;
  status: 'done' | 'active' | 'pending' | 'error';
}

/**
 * Reusable Agent Run Timeline (Phase 3, Part 6). Every step label here comes
 * from a real orchestrator status event — this component only renders what
 * it is given, it never invents step names.
 */
export function AgentRunTimeline({
  steps,
  className,
}: {
  steps: AgentTimelineStep[];
  className?: string;
}) {
  if (steps.length === 0) return null;
  return (
    <ol className={cn('space-y-1.5', className)} aria-label="Agent run progress">
      {steps.map((step) => (
        <li key={step.id} className="flex items-center gap-2 text-xs">
          <StepIcon status={step.status} />
          <span
            className={cn(
              step.status === 'pending' && 'text-muted-foreground',
              step.status === 'active' && 'text-foreground font-medium',
              step.status === 'done' && 'text-muted-foreground',
              step.status === 'error' && 'text-destructive',
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepIcon({ status }: { status: AgentTimelineStep['status'] }) {
  if (status === 'done') return <Check className="text-success size-3.5 shrink-0" aria-hidden />;
  if (status === 'active')
    return <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" aria-hidden />;
  if (status === 'error')
    return (
      <span className="text-destructive size-3.5 shrink-0 text-center leading-none" aria-hidden>
        ✕
      </span>
    );
  return (
    <span
      className="border-muted-foreground/50 inline-block size-1.5 shrink-0 rounded-full border"
      aria-hidden
    />
  );
}

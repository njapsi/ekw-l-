'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@growth-agent/ui';
import {
  createExperimentAction,
  disconnectYouTubeAction,
  dismissOpportunityAction,
  generateCalendarAction,
  promoteOpportunityAction,
  regenerateOpportunitiesAction,
  runAnalystAction,
  syncYouTubeAction,
} from '@/server/youtube-actions';

type Result = { ok: boolean; error?: string; message?: string };

function useServerAction(fn: () => Promise<Result>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const run = () =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) router.refresh();
    });
  return { pending, result, run };
}

export function SyncButton({
  facet = 'all',
  children = 'Sync now',
}: {
  facet?: 'all' | 'channel' | 'videos' | 'analytics';
  children?: React.ReactNode;
}) {
  const { pending, result, run } = useServerAction(() => syncYouTubeAction(facet));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        {pending ? 'Syncing…' : children}
      </Button>
      {result ? (
        <span
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
        >
          {result.ok ? result.message : result.error}
        </span>
      ) : null}
    </span>
  );
}

export function RunAnalystButton({ disabled }: { disabled?: boolean }) {
  const { pending, result, run } = useServerAction(runAnalystAction);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={pending || disabled}>
        {pending ? 'Analyzing…' : 'Run analysis'}
      </Button>
      {result ? (
        <span
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
        >
          {result.ok ? result.message : result.error}
        </span>
      ) : null}
    </span>
  );
}

export function RegenerateOpportunitiesButton() {
  const { pending, result, run } = useServerAction(regenerateOpportunitiesAction);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={pending}>
        {pending ? 'Analyzing…' : 'Regenerate opportunities'}
      </Button>
      {result ? (
        <span
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
        >
          {result.ok ? result.message : result.error}
        </span>
      ) : null}
    </span>
  );
}

export function PromoteOpportunityButton({ opportunityId }: { opportunityId: string }) {
  const { pending, result, run } = useServerAction(() => promoteOpportunityAction(opportunityId));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        {pending ? 'Adding…' : 'Add to Tasks'}
      </Button>
      {result && !result.ok ? (
        <span role="alert" className="text-destructive text-xs">
          {result.error}
        </span>
      ) : null}
    </span>
  );
}

export function DismissOpportunityButton({ opportunityId }: { opportunityId: string }) {
  const { pending, run } = useServerAction(() => dismissOpportunityAction(opportunityId));
  return (
    <Button size="sm" variant="ghost" onClick={run} disabled={pending}>
      {pending ? 'Dismissing…' : 'Dismiss'}
    </Button>
  );
}

export function GenerateCalendarForm() {
  const [cadence, setCadence] = useState(2);
  const [weeks, setWeeks] = useState(4);
  const { pending, result, run } = useServerAction(() => generateCalendarAction(cadence, weeks));
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="cadence" className="text-xs">
          Videos / week
        </Label>
        <Input
          id="cadence"
          type="number"
          min={1}
          max={14}
          className="w-20"
          value={cadence}
          onChange={(e) => setCadence(Number(e.target.value) || 1)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="weeks" className="text-xs">
          Weeks
        </Label>
        <Input
          id="weeks"
          type="number"
          min={1}
          max={12}
          className="w-20"
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value) || 1)}
        />
      </div>
      <Button size="sm" onClick={run} disabled={pending}>
        {pending ? 'Planning…' : 'Generate calendar'}
      </Button>
      {result ? (
        <span
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
        >
          {result.ok ? result.message : result.error}
        </span>
      ) : null}
    </div>
  );
}

export function CreateExperimentForm() {
  const [hypothesis, setHypothesis] = useState('');
  const [variable, setVariable] = useState('');
  const [successMetric, setSuccessMetric] = useState('');
  const [expectedDirection, setExpectedDirection] = useState<'INCREASE' | 'DECREASE'>('INCREASE');
  const [experimentNote, setExperimentNote] = useState('');
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const router = useRouter();

  const submit = () =>
    startTransition(async () => {
      const r = await createExperimentAction({
        hypothesis,
        variable,
        successMetric,
        expectedDirection,
        experimentNote,
      });
      setResult(r);
      if (r.ok) {
        setHypothesis('');
        setVariable('');
        setSuccessMetric('');
        setExperimentNote('');
        router.refresh();
      }
    });

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="hypothesis" className="text-xs">
            Hypothesis
          </Label>
          <Input
            id="hypothesis"
            placeholder="Shorter titles increase click-through rate"
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="variable" className="text-xs">
            Variable being changed
          </Label>
          <Input
            id="variable"
            placeholder="Title length"
            value={variable}
            onChange={(e) => setVariable(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="successMetric" className="text-xs">
            Success metric
          </Label>
          <Input
            id="successMetric"
            placeholder="Click-through rate"
            value={successMetric}
            onChange={(e) => setSuccessMetric(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="direction" className="text-xs">
            Expected direction
          </Label>
          <select
            id="direction"
            className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            value={expectedDirection}
            onChange={(e) => setExpectedDirection(e.target.value as 'INCREASE' | 'DECREASE')}
          >
            <option value="INCREASE">Increase</option>
            <option value="DECREASE">Decrease</option>
          </select>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="note" className="text-xs">
          Notes
        </Label>
        <Input
          id="note"
          placeholder="Testing for two weeks across all new uploads."
          value={experimentNote}
          onChange={(e) => setExperimentNote(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Creating…' : 'Create experiment'}
        </Button>
        {result ? (
          <span
            role={result.ok ? 'status' : 'alert'}
            className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
          >
            {result.ok ? result.message : result.error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function DisconnectButton() {
  const { pending, result, run } = useServerAction(disconnectYouTubeAction);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        className="text-destructive"
        onClick={run}
        disabled={pending}
      >
        {pending ? 'Disconnecting…' : 'Disconnect'}
      </Button>
      {result && !result.ok ? (
        <span role="alert" className="text-destructive text-xs">
          {result.error}
        </span>
      ) : null}
    </span>
  );
}

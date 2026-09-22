'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@growth-agent/ui';
import {
  createTikTokExperimentAction,
  disconnectTikTokAction,
  dismissTikTokOpportunityAction,
  generateTikTokContentPlanAction,
  promoteTikTokOpportunityAction,
  refreshTikTokStatusAction,
  regenerateTikTokOpportunitiesAction,
  runTikTokAnalystAction,
  syncTikTokAction,
} from '@/server/tiktok-actions';

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

function Status({ result }: { result: Result | null }) {
  if (!result) return null;
  return (
    <span
      role={result.ok ? 'status' : 'alert'}
      className={result.ok ? 'text-muted-foreground text-xs' : 'text-destructive text-xs'}
    >
      {result.ok ? result.message : result.error}
    </span>
  );
}

export function TikTokSyncButton({
  facet = 'all',
  children = 'Sync now',
}: {
  facet?: 'all' | 'account' | 'videos';
  children?: React.ReactNode;
}) {
  const { pending, result, run } = useServerAction(() => syncTikTokAction(facet));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="outline" onClick={run} disabled={pending}>
        {pending ? 'Syncing…' : children}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function RunTikTokAnalystButton({ disabled }: { disabled?: boolean }) {
  const { pending, result, run } = useServerAction(runTikTokAnalystAction);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={pending || disabled}>
        {pending ? 'Analyzing…' : 'Run analysis'}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function DisconnectTikTokButton() {
  const { pending, result, run } = useServerAction(disconnectTikTokAction);
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

export function RegenerateTikTokOpportunitiesButton() {
  const { pending, result, run } = useServerAction(regenerateTikTokOpportunitiesAction);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={run} disabled={pending}>
        {pending ? 'Analyzing…' : 'Regenerate opportunities'}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function PromoteTikTokOpportunityButton({ opportunityId }: { opportunityId: string }) {
  const { pending, result, run } = useServerAction(() =>
    promoteTikTokOpportunityAction(opportunityId),
  );
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

export function DismissTikTokOpportunityButton({ opportunityId }: { opportunityId: string }) {
  const { pending, run } = useServerAction(() => dismissTikTokOpportunityAction(opportunityId));
  return (
    <Button size="sm" variant="ghost" onClick={run} disabled={pending}>
      {pending ? 'Dismissing…' : 'Dismiss'}
    </Button>
  );
}

export function GenerateTikTokContentPlanForm() {
  const [cadence, setCadence] = useState(3);
  const [weeks, setWeeks] = useState(4);
  const { pending, result, run } = useServerAction(() =>
    generateTikTokContentPlanAction(cadence, weeks),
  );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="tt-cadence" className="text-xs">
          Videos / week
        </Label>
        <Input
          id="tt-cadence"
          type="number"
          min={1}
          max={21}
          className="w-20"
          value={cadence}
          onChange={(e) => setCadence(Number(e.target.value) || 1)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="tt-weeks" className="text-xs">
          Weeks
        </Label>
        <Input
          id="tt-weeks"
          type="number"
          min={1}
          max={12}
          className="w-20"
          value={weeks}
          onChange={(e) => setWeeks(Number(e.target.value) || 1)}
        />
      </div>
      <Button size="sm" onClick={run} disabled={pending}>
        {pending ? 'Planning…' : 'Generate content plan'}
      </Button>
      <Status result={result} />
    </div>
  );
}

export function CreateTikTokExperimentForm() {
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
      const r = await createTikTokExperimentAction({
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
          <Label htmlFor="tt-hypothesis" className="text-xs">
            Hypothesis
          </Label>
          <Input
            id="tt-hypothesis"
            placeholder="Shorter hooks increase watch time"
            value={hypothesis}
            onChange={(e) => setHypothesis(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tt-variable" className="text-xs">
            Variable being changed
          </Label>
          <Input
            id="tt-variable"
            placeholder="Hook length"
            value={variable}
            onChange={(e) => setVariable(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tt-successMetric" className="text-xs">
            Success metric
          </Label>
          <Input
            id="tt-successMetric"
            placeholder="Average watch time"
            value={successMetric}
            onChange={(e) => setSuccessMetric(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="tt-direction" className="text-xs">
            Expected direction
          </Label>
          <select
            id="tt-direction"
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
        <Label htmlFor="tt-note" className="text-xs">
          Notes
        </Label>
        <Input
          id="tt-note"
          placeholder="Testing for two weeks across all new uploads."
          value={experimentNote}
          onChange={(e) => setExperimentNote(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={submit} disabled={pending}>
          {pending ? 'Creating…' : 'Create experiment'}
        </Button>
        <Status result={result} />
      </div>
    </div>
  );
}

export function RefreshStatusButton({ publishRowId }: { publishRowId: string }) {
  const { pending, result, run } = useServerAction(() => refreshTikTokStatusAction(publishRowId));
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" onClick={run} disabled={pending}>
        {pending ? 'Checking…' : 'Check status'}
      </Button>
      <Status result={result} />
    </span>
  );
}

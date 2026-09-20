'use client';

import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@growth-agent/ui';
import { updateGovernanceAction } from '@/server/settings-actions';
import { ActionOutcome, useAction } from './shared';

type Mode = 'automatic' | 'approval_required' | 'disabled';
type Gated = 'approval_required' | 'disabled';
interface IntegrationPolicy {
  agentAllowed: boolean;
  analyze: Mode;
  generate: Mode;
  draft: Mode;
  modify: Gated;
  publish: Gated;
  delete: Gated;
}
export interface GovernancePolicyView {
  version: 1;
  integrations: Record<string, IntegrationPolicy>;
  automation: { minIntervalMinutes: number; allowedTaskTypes: string[] };
  approvalTtlMinutes: number;
}

const CLASSES: Array<{
  key: keyof Omit<IntegrationPolicy, 'agentAllowed'>;
  label: string;
  gated: boolean;
}> = [
  { key: 'analyze', label: 'Analyze', gated: false },
  { key: 'generate', label: 'Generate', gated: false },
  { key: 'draft', label: 'Draft', gated: false },
  { key: 'modify', label: 'Modify', gated: true },
  { key: 'publish', label: 'Publish', gated: true },
  { key: 'delete', label: 'Delete', gated: true },
];

const INTEGRATION_LABEL: Record<string, string> = {
  YOUTUBE: 'YouTube',
  TIKTOK: 'TikTok',
  WORDPRESS: 'WordPress',
  GOOGLE_SEARCH_CONSOLE: 'Search Console',
  WEBSITE: 'Website (SEO)',
};

const TASK_LABEL: Record<string, string> = {
  YOUTUBE_ANALYSIS: 'YouTube analysis',
  TIKTOK_ANALYSIS: 'TikTok analysis',
  WEBSITE_CRAWL: 'Website crawl',
  SEO_ISSUE_ALERT: 'SEO issue alert',
  MONETIZATION_SCAN: 'Monetization scan',
  GROWTH_REPORT: 'Growth report',
  CONTENT_OPPORTUNITY: 'Content opportunity',
};

const MODE_LABEL: Record<Mode, string> = {
  automatic: 'Automatic',
  approval_required: 'Approval required',
  disabled: 'Disabled',
};

export function GovernanceForm({
  initial,
  allTaskTypes,
  canEdit,
}: {
  initial: GovernancePolicyView;
  allTaskTypes: string[];
  canEdit: boolean;
}) {
  const [policy, setPolicy] = useState<GovernancePolicyView>(initial);
  const save = useAction(updateGovernanceAction);

  function setCell(integration: string, key: keyof IntegrationPolicy, value: Mode | boolean) {
    setPolicy((p) => ({
      ...p,
      integrations: {
        ...p.integrations,
        [integration]: { ...p.integrations[integration]!, [key]: value },
      },
    }));
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save.run(policy);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What AI may do, per integration</CardTitle>
          <CardDescription>
            Applies to work started by the AI agent and by automations. Modify, publish and delete
            can never run without a human approval — the strictest choice you can make here is to
            disable them.
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="text-muted-foreground text-left text-xs">
              <tr>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Integration
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  Agent access
                </th>
                {CLASSES.map((c) => (
                  <th key={c.key} scope="col" className="px-2 py-2 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(policy.integrations).map((k) => {
                const row = policy.integrations[k]!;
                return (
                  <tr key={k} className="border-t align-middle">
                    <th scope="row" className="py-2 pr-3 text-left font-medium">
                      {INTEGRATION_LABEL[k] ?? k}
                    </th>
                    <td className="px-2 py-2">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={row.agentAllowed}
                          disabled={!canEdit}
                          onChange={(e) => setCell(k, 'agentAllowed', e.target.checked)}
                        />
                        Allowed
                      </label>
                    </td>
                    {CLASSES.map((c) => (
                      <td key={c.key} className="px-2 py-2">
                        <select
                          aria-label={`${INTEGRATION_LABEL[k] ?? k}: ${c.label}`}
                          className="border-input bg-background h-8 rounded-md border px-1 text-xs"
                          value={row[c.key]}
                          disabled={!canEdit}
                          onChange={(e) => setCell(k, c.key, e.target.value as Mode)}
                        >
                          {(c.gated
                            ? (['approval_required', 'disabled'] as Mode[])
                            : (Object.keys(MODE_LABEL) as Mode[])
                          ).map((m) => (
                            <option key={m} value={m}>
                              {MODE_LABEL[m]}
                            </option>
                          ))}
                        </select>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Background automation</CardTitle>
          <CardDescription>
            Checked when an automation is saved and again every time it runs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="g-approval-ttl">Approval requests expire after (minutes)</Label>
            <Input
              id="g-approval-ttl"
              type="number"
              min={15}
              max={43200}
              value={policy.approvalTtlMinutes}
              disabled={!canEdit}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  approvalTtlMinutes: Number(e.target.value) || 15,
                }))
              }
            />
            <p className="text-muted-foreground text-xs">
              A pending Publish/Modify/Delete request a human hasn&apos;t decided on by then expires
              and must be recreated — it never executes silently later. Default 10,080 (7 days).
            </p>
          </div>
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="g-interval">Minimum minutes between runs of one automation</Label>
            <Input
              id="g-interval"
              type="number"
              min={15}
              max={10080}
              value={policy.automation.minIntervalMinutes}
              disabled={!canEdit}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  automation: { ...p.automation, minIntervalMinutes: Number(e.target.value) || 15 },
                }))
              }
            />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Allowed background jobs</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {allTaskTypes.map((t) => (
                <label key={t} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={policy.automation.allowedTaskTypes.includes(t)}
                    onChange={(e) =>
                      setPolicy((p) => ({
                        ...p,
                        automation: {
                          ...p.automation,
                          allowedTaskTypes: e.target.checked
                            ? [...p.automation.allowedTaskTypes, t]
                            : p.automation.allowedTaskTypes.filter((x) => x !== t),
                        },
                      }))
                    }
                  />
                  {TASK_LABEL[t] ?? t}
                </label>
              ))}
            </div>
          </fieldset>
        </CardContent>
      </Card>

      {canEdit ? (
        <div className="space-y-2">
          <ActionOutcome result={save.result} />
          <Button type="submit" disabled={save.pending}>
            {save.pending ? 'Saving…' : 'Save policy'}
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">
          Only owners and admins can change this policy.
        </p>
      )}
    </form>
  );
}

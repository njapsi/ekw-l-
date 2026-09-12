'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@growth-agent/ui';
import { createAutomationAction } from '@/server/automation-actions';

export interface TaskTypeOption {
  key: string;
  label: string;
  description: string;
  example: string;
  requiredAction: string;
  needsWebsite: boolean;
  isAlert: boolean;
  isReport: boolean;
}

export interface WebsiteOption {
  id: string;
  hostname: string;
}

const CADENCES = [
  { value: 'DAILY', label: 'Daily' },
  { value: 'WEEKLY', label: 'Weekly' },
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'CUSTOM', label: 'Custom (cron)' },
] as const;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const REPORT_TYPES = [
  'GROWTH',
  'YOUTUBE',
  'TIKTOK',
  'SEO',
  'WEBSITE_HEALTH',
  'AI_RECOMMENDATIONS',
  'MONETIZATION',
];

export function NewAutomationForm({
  taskTypes,
  websites,
}: {
  taskTypes: TaskTypeOption[];
  websites: WebsiteOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const [taskType, setTaskType] = useState(taskTypes[0]?.key ?? '');
  const [name, setName] = useState('');
  const [cadence, setCadence] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM'>('WEEKLY');
  const [hour, setHour] = useState('9');
  const [minute, setMinute] = useState('0');
  const [weekday, setWeekday] = useState('1');
  const [monthday, setMonthday] = useState('1');
  const [cron, setCron] = useState('0 9 * * 1');
  const [websiteId, setWebsiteId] = useState(websites[0]?.id ?? '');
  const [severity, setSeverity] = useState<'critical' | 'high'>('critical');
  const [reportType, setReportType] = useState('GROWTH');

  const selected = useMemo(() => taskTypes.find((t) => t.key === taskType), [taskTypes, taskType]);

  const submit = () =>
    start(async () => {
      setMsg(null);
      const config: Record<string, unknown> = {};
      if (selected?.needsWebsite && websiteId) config.websiteId = websiteId;
      if (selected?.isAlert) config.severity = severity;
      if (selected?.isReport) {
        config.reportType = reportType;
        if (reportType === 'SEO' || reportType === 'WEBSITE_HEALTH') {
          if (websiteId) config.websiteId = websiteId;
        }
      }
      const r = await createAutomationAction({
        name: name.trim() || (selected?.label ?? 'Automation'),
        taskType,
        cadence,
        cronExpression: cadence === 'CUSTOM' ? cron : undefined,
        hour: Number(hour),
        minute: Number(minute),
        weekday: Number(weekday),
        monthday: Number(monthday),
        config,
      });
      if (r.ok && r.automationId) {
        router.push(`/app/automations/${r.automationId}`);
        return;
      }
      setMsg({ ok: false, text: r.error ?? 'Failed to create the automation.' });
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div>
        <Label>What should run</Label>
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          {taskTypes.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTaskType(t.key)}
              className={`rounded border p-2 text-left text-sm ${
                t.key === taskType ? 'border-primary bg-primary/5' : 'border-border'
              }`}
            >
              <span className="font-medium">{t.label}</span>
              <span className="text-muted-foreground block text-xs">{t.description}</span>
              <span className="text-muted-foreground mt-1 block text-xs italic">
                e.g. &ldquo;{t.example}&rdquo;
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="a-name">Name</Label>
          <Input
            id="a-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={selected?.label ?? 'My automation'}
          />
        </div>
        <div>
          <Label htmlFor="a-cadence">Schedule</Label>
          <select
            id="a-cadence"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as typeof cadence)}
          >
            {CADENCES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {cadence === 'CUSTOM' ? (
        <div>
          <Label htmlFor="a-cron">Cron expression (UTC)</Label>
          <Input
            id="a-cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="0 9 * * 1"
          />
          <p className="text-muted-foreground mt-1 text-xs">
            5 fields: minute hour day-of-month month day-of-week. Evaluated in UTC.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="a-hour">Hour (UTC)</Label>
            <Input
              id="a-hour"
              type="number"
              min={0}
              max={23}
              value={hour}
              onChange={(e) => setHour(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="a-min">Minute</Label>
            <Input
              id="a-min"
              type="number"
              min={0}
              max={59}
              value={minute}
              onChange={(e) => setMinute(e.target.value)}
            />
          </div>
          {cadence === 'WEEKLY' ? (
            <div className="sm:col-span-2">
              <Label htmlFor="a-wd">Day of week</Label>
              <select
                id="a-wd"
                className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                value={weekday}
                onChange={(e) => setWeekday(e.target.value)}
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          {cadence === 'MONTHLY' ? (
            <div className="sm:col-span-2">
              <Label htmlFor="a-md">Day of month (1–28)</Label>
              <Input
                id="a-md"
                type="number"
                min={1}
                max={28}
                value={monthday}
                onChange={(e) => setMonthday(e.target.value)}
              />
            </div>
          ) : null}
        </div>
      )}

      {selected?.needsWebsite ||
      (selected?.isReport && (reportType === 'SEO' || reportType === 'WEBSITE_HEALTH')) ? (
        <div>
          <Label htmlFor="a-site">Website</Label>
          {websites.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              No websites registered — add one under SEO first.
            </p>
          ) : (
            <select
              id="a-site"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={websiteId}
              onChange={(e) => setWebsiteId(e.target.value)}
            >
              <option value="">First verified website</option>
              {websites.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.hostname}
                </option>
              ))}
            </select>
          )}
        </div>
      ) : null}

      {selected?.isAlert ? (
        <div>
          <Label htmlFor="a-sev">Alert on</Label>
          <select
            id="a-sev"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as 'critical' | 'high')}
          >
            <option value="critical">Critical issues only</option>
            <option value="high">Critical or high issues</option>
          </select>
        </div>
      ) : null}

      {selected?.isReport ? (
        <div>
          <Label htmlFor="a-rt">Report type</Label>
          <select
            id="a-rt"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={reportType}
            onChange={(e) => setReportType(e.target.value)}
          >
            {REPORT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        This automation runs with <strong>your</strong> permissions ({selected?.requiredAction}). It
        never publishes anything externally.
      </p>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create automation'}
        </Button>
        {msg ? (
          <span
            role={msg.ok ? 'status' : 'alert'}
            className={`text-sm ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
          >
            {msg.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}

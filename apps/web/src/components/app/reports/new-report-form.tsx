'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import { generateReportAction } from '@/server/report-actions';

export interface TypeOption {
  type: string;
  label: string;
  blurb: string;
  available: boolean;
  reason: string;
}

export function NewReportForm({ options }: { options: TypeOption[] }) {
  const router = useRouter();
  const [type, setType] = useState(
    options.find((o) => o.available)?.type ?? options[0]?.type ?? '',
  );
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const selected = options.find((o) => o.type === type);

  const submit = () =>
    start(async () => {
      setMsg(null);
      const r = await generateReportAction({ type });
      if (r.ok && r.reportId) {
        router.push(`/app/reports/${r.reportId}`);
        return;
      }
      setMsg({ ok: false, text: r.error ?? 'Failed to generate the report.' });
    });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {options.map((o) => (
          <button
            key={o.type}
            type="button"
            onClick={() => setType(o.type)}
            className={`rounded border p-3 text-left text-sm ${
              o.type === type ? 'border-foreground bg-muted' : 'border-border'
            }`}
          >
            <span className="font-medium">{o.label}</span>
            <span className="text-muted-foreground mt-0.5 block text-xs">{o.blurb}</span>
            {!o.available ? (
              <span className="text-muted-foreground mt-1 block text-xs italic">{o.reason}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || !type}>
          {pending ? 'Generating…' : 'Generate report'}
        </Button>
        {selected && !selected.available ? (
          <span className="text-muted-foreground text-xs">
            You can still generate it — it will note the missing data.
          </span>
        ) : null}
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

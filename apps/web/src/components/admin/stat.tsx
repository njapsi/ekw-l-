import type { ReactNode } from 'react';
import { Card, CardDescription, CardHeader, CardTitle } from '@growth-agent/ui';

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">{children}</div>;
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-xl tabular-nums">{value}</CardTitle>
        {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
      </CardHeader>
    </Card>
  );
}

const TONE: Record<string, string> = {
  ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  degraded: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  down: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  unconfigured: 'bg-muted text-muted-foreground',
};

export function HealthPill({ state }: { state: string }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${TONE[state] ?? TONE.unconfigured}`}
    >
      {state}
    </span>
  );
}

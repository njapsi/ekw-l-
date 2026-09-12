'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import { analyzeProjectAction, generateAssetsAction } from '@/server/content-actions';

type Result = { ok: boolean; error?: string; message?: string };

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

export function AnalyzeButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() =>
          start(async () => {
            const r = await analyzeProjectAction(projectId);
            setResult(r);
            if (r.ok) router.refresh();
          })
        }
        disabled={pending}
      >
        {pending ? 'Analyzing…' : 'Analyze source'}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function GenerateButton({
  projectId,
  label = 'Generate all 13 content types',
}: {
  projectId: string;
  label?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        onClick={() =>
          start(async () => {
            const r = await generateAssetsAction(projectId);
            setResult(r);
            if (r.ok) router.refresh();
          })
        }
        disabled={pending}
      >
        {pending ? 'Generating…' : label}
      </Button>
      <Status result={result} />
    </span>
  );
}

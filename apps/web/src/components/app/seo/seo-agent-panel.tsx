'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@growth-agent/ui';
import { runSeoAgentAction } from '@/server/seo-actions';

const EXAMPLES = [
  "Why isn't Google finding these pages?",
  'Which pages are blocked from crawling?',
  'Where are my canonical conflicts?',
  'Which pages are orphaned?',
  'Which technical SEO problems should I fix first?',
  'How can I make my website easier for AI agents to understand?',
];

export function SeoAgentPanel({ crawlId, canRun }: { crawlId: string; canRun: boolean }) {
  const router = useRouter();
  const [question, setQuestion] = useState('');
  const [goals, setGoals] = useState('');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{
    ok: boolean;
    message?: string;
    error?: string;
    answer?: string;
  } | null>(null);

  const run = () =>
    start(async () => {
      const r = await runSeoAgentAction(crawlId, {
        question: question.trim(),
        goals: goals.trim(),
      });
      setResult(r);
      if (r.ok) router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor="seo-agent-q">Ask the agent (optional)</Label>
        <Input
          id="seo-agent-q"
          placeholder="Which technical SEO problems should I fix first?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <div className="flex flex-wrap gap-1 pt-1">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="border-border text-muted-foreground hover:bg-muted rounded border px-2 py-0.5 text-xs"
              onClick={() => setQuestion(ex)}
            >
              {ex}
            </button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="seo-agent-goals">Your goals (optional, one per line)</Label>
        <Input
          id="seo-agent-goals"
          placeholder="Get product pages indexed; improve structured data"
          value={goals}
          onChange={(e) => setGoals(e.target.value)}
        />
      </div>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={run} disabled={pending || !canRun}>
          {pending ? 'Analysing…' : 'Run AI SEO Agent'}
        </Button>
        {!canRun ? (
          <span className="text-muted-foreground text-xs">
            Available once the crawl has completed.
          </span>
        ) : null}
      </div>
      {result ? (
        <div
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'bg-muted/40 rounded-md p-3 text-sm' : 'text-destructive text-sm'}
        >
          {result.ok ? (result.answer ?? result.message) : result.error}
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">
        The agent reasons over the stored crawl data through restricted read-only tools. It does not
        crawl your site, cannot change it, and never predicts or guarantees rankings.
      </p>
    </div>
  );
}

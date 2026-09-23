'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Textarea } from '@growth-agent/ui';
import { createResearchProjectAction } from '@/server/research-actions';

export function ResearchForm() {
  const router = useRouter();
  const [question, setQuestion] = useState('');
  const [objective, setObjective] = useState('');
  const [urls, setUrls] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const seedUrls = urls
      .split('\n')
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 10);
    const result = await createResearchProjectAction({
      question,
      objective: objective || undefined,
      config: seedUrls.length > 0 ? { seedUrls, maxSources: seedUrls.length } : undefined,
    });
    setPending(false);
    if (!result.ok || !result.researchId) {
      setError(result.error ?? 'Could not start research.');
      return;
    }
    router.push(`/app/research/${result.researchId}`);
  }

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="r-question">Research question</Label>
        <Textarea
          id="r-question"
          rows={2}
          placeholder="e.g. What are current best practices for YouTube Shorts hooks?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="r-objective">Why does this matter? (optional)</Label>
        <Input
          id="r-objective"
          placeholder="What will you do with the answer?"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="r-urls">Sources (one URL per line)</Label>
        <Textarea
          id="r-urls"
          rows={4}
          placeholder={'https://example.com/article-one\nhttps://example.com/article-two'}
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          No web-search provider is configured for this deployment, so research can only fetch
          URLs you give it here — it never invents or guesses sources.
        </p>
      </div>
      <Button type="submit" disabled={pending || !question.trim()}>
        {pending ? 'Starting…' : 'Start research'}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

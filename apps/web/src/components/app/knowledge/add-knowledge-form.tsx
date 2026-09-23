'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Textarea } from '@growth-agent/ui';
import { createKnowledgeItemAction, ingestDocumentAction } from '@/server/knowledge-actions';

const TYPES = [
  'BUSINESS_PROFILE',
  'BRAND_PROFILE',
  'AUDIENCE_PROFILE',
  'PRODUCT',
  'SERVICE',
  'OFFER',
  'COMPETITOR',
  'MARKET',
  'STRATEGY',
  'GOAL',
  'CONSTRAINT',
  'PROCESS',
  'DOCUMENT',
  'CUSTOMER_INSIGHT',
  'GROWTH_INSIGHT',
] as const;

const IMPORTANCE = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export function AddKnowledgeForm() {
  const router = useRouter();
  const [mode, setMode] = useState<'write' | 'url'>('write');
  const [type, setType] = useState<string>('BUSINESS_PROFILE');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [url, setUrl] = useState('');
  const [importance, setImportance] = useState<string>('MEDIUM');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setPending(true);
    setError(null);
    const result =
      mode === 'write'
        ? await createKnowledgeItemAction({
            type: type as never,
            title,
            content,
            importance: importance as never,
            classification: 'USER_PROVIDED',
            status: 'ACTIVE',
            source: { type: 'USER_INPUT' },
          })
        : await ingestDocumentAction({
            title: title || url,
            type: 'DOCUMENT',
            url,
            importance: importance as never,
          });
    setPending(false);
    if (!result.ok || !result.knowledgeId) {
      setError(result.error ?? 'Could not save this.');
      return;
    }
    router.push(`/app/knowledge/${result.knowledgeId}`);
  }

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('write')}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
            mode === 'write'
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-input text-foreground'
          }`}
          aria-pressed={mode === 'write'}
        >
          Write it
        </button>
        <button
          type="button"
          onClick={() => setMode('url')}
          className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
            mode === 'url' ? 'border-primary bg-primary text-primary-foreground' : 'border-input text-foreground'
          }`}
          aria-pressed={mode === 'url'}
        >
          Import from a URL
        </button>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="k-title">Title</Label>
        <Input
          id="k-title"
          placeholder={mode === 'write' ? 'e.g. Our target audience' : 'Optional — defaults to the URL'}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required={mode === 'write'}
        />
      </div>

      {mode === 'write' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="k-type">Type</Label>
            <select
              id="k-type"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="k-content">Content</Label>
            <Textarea
              id="k-content"
              rows={6}
              placeholder="Write what you want the AI to remember about your business."
              value={content}
              onChange={(e) => setContent(e.target.value)}
              required
            />
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <Label htmlFor="k-url">URL</Label>
          <Input
            id="k-url"
            type="url"
            placeholder="https://example.com/about-us"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <p className="text-muted-foreground text-xs">
            Fetched through the same SSRF-safe reader the research tool uses; private/internal
            addresses are always refused. Stored as untrusted external content, labelled
            accordingly.
          </p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="k-importance">Importance</Label>
        <select
          id="k-importance"
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          value={importance}
          onChange={(e) => setImportance(e.target.value)}
        >
          {IMPORTANCE.map((i) => (
            <option key={i} value={i}>
              {i.toLowerCase()}
            </option>
          ))}
        </select>
      </div>

      <Button type="submit" disabled={pending || (mode === 'write' ? !content.trim() : !url.trim())}>
        {pending ? 'Saving…' : 'Save knowledge'}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

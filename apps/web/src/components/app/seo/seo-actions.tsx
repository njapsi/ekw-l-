'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label } from '@growth-agent/ui';
import {
  addWebsiteAction,
  cancelCrawlAction,
  pauseCrawlAction,
  resumeCrawlAction,
  runSeoAuditSummaryAction,
  startCrawlAction,
  verifyWebsiteAction,
} from '@/server/seo-actions';

type Result = { ok: boolean; error?: string; message?: string; websiteId?: string };

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

export function AddWebsiteForm() {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addWebsiteAction(url.trim());
          setResult(r);
          if (r.ok) {
            setUrl('');
            router.refresh();
          }
        });
      }}
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="website-url">Website URL</Label>
        <Input
          id="website-url"
          type="url"
          required
          placeholder="https://example.com"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <Button type="submit" disabled={pending || !url}>
        {pending ? 'Adding…' : 'Add website'}
      </Button>
      <div className="sm:pb-2">
        <Status result={result} />
      </div>
    </form>
  );
}

export function VerifyWebsiteButton({ websiteId }: { websiteId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await verifyWebsiteAction(websiteId);
            setResult(r);
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? 'Checking…' : 'Check verification'}
      </Button>
      <Status result={result} />
    </span>
  );
}

export function StartCrawlForm({ websiteId, verified }: { websiteId: string; verified: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const [maxPages, setMaxPages] = useState(verified ? 200 : 10);
  const [maxDepth, setMaxDepth] = useState(verified ? 5 : 1);
  const [renderMode, setRenderMode] = useState<'STATIC' | 'AUTO' | 'HEADLESS'>('STATIC');

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await startCrawlAction(websiteId, { maxPages, maxDepth, renderMode });
          setResult(r);
          if (r.ok) router.refresh();
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="mp">Max pages</Label>
          <Input
            id="mp"
            type="number"
            min={1}
            max={verified ? 200000 : 10}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="md">Max depth</Label>
          <Input
            id="md"
            type="number"
            min={0}
            max={verified ? 20 : 1}
            value={maxDepth}
            onChange={(e) => setMaxDepth(Number(e.target.value))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rm">Rendering</Label>
          <select
            id="rm"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={renderMode}
            disabled={!verified}
            onChange={(e) => setRenderMode(e.target.value as 'STATIC' | 'AUTO' | 'HEADLESS')}
          >
            <option value="STATIC">Static HTML only</option>
            <option value="AUTO">Auto (render thin pages)</option>
            <option value="HEADLESS">Headless (render every page)</option>
          </select>
        </div>
      </div>
      {!verified ? (
        <p className="text-muted-foreground text-xs">
          Ownership isn’t verified, so this crawl is limited to a shallow public sample (≤ 10 pages,
          depth ≤ 1, no rendering).
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Crawling…' : 'Start crawl'}
        </Button>
        <Status result={result} />
      </div>
    </form>
  );
}

export function CrawlControls({ crawlId, status }: { crawlId: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  const act = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) router.refresh();
    });

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {status === 'RUNNING' ? (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => act(() => pauseCrawlAction(crawlId))}
          >
            Pause
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={pending}
            onClick={() => act(() => cancelCrawlAction(crawlId))}
          >
            Cancel
          </Button>
        </>
      ) : null}
      {status === 'PAUSED' ? (
        <Button size="sm" disabled={pending} onClick={() => act(() => resumeCrawlAction(crawlId))}>
          Resume
        </Button>
      ) : null}
      <Status result={result} />
    </span>
  );
}

export function RunAuditSummaryButton({
  crawlId,
  disabled,
}: {
  crawlId: string;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        disabled={pending || disabled}
        onClick={() =>
          start(async () => {
            const r = await runSeoAuditSummaryAction(crawlId);
            setResult(r);
            if (r.ok) router.refresh();
          })
        }
      >
        {pending ? 'Summarizing…' : 'Generate AI summary'}
      </Button>
      <Status result={result} />
    </span>
  );
}

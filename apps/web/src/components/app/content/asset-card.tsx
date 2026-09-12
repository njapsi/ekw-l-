'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Textarea } from '@growth-agent/ui';
import {
  approveAssetAction,
  editAssetAction,
  markFailedAction,
  markPublishedAction,
  regenerateAssetAction,
  resetAssetAction,
  revertAssetAction,
  scheduleAssetAction,
  unscheduleAssetAction,
} from '@/server/content-actions';

export interface AssetView {
  id: string;
  type: string;
  platform: string;
  title: string | null;
  status: string;
  sourceAngle: string | null;
  scheduledFor: string | Date | null;
  publishedAt: string | Date | null;
  publishTarget: string | null;
  failureReason: string | null;
  versionCount: number;
  currentVersionNumber: number | null;
  body: string;
}

const TYPE_LABEL: Record<string, string> = {
  YT_TITLE_ALTERNATIVES: 'YouTube title alternatives',
  YT_DESCRIPTION: 'YouTube description',
  YT_CHAPTERS: 'YouTube chapters',
  SHORTS_IDEA: 'Shorts idea',
  TIKTOK_IDEA: 'TikTok idea',
  TIKTOK_CAPTION: 'TikTok caption',
  HOOK: 'Hooks',
  SCRIPT: 'Script',
  SOCIAL_POST: 'Social post',
  BLOG_IDEA: 'Blog idea',
  SEO_ARTICLE_OUTLINE: 'SEO article outline',
  FAQ: 'FAQ',
  NEWSLETTER_IDEA: 'Newsletter idea',
};

const STATUS_VARIANT: Record<string, 'secondary' | 'outline' | 'destructive'> = {
  DRAFT: 'outline',
  APPROVED: 'secondary',
  SCHEDULED: 'secondary',
  PUBLISHED: 'secondary',
  FAILED: 'destructive',
};

export function AssetCard({ asset, projectId }: { asset: AssetView; projectId: string }) {
  const router = useRouter();
  const [body, setBody] = useState(asset.body);
  const [dirty, setDirty] = useState(false);
  const [when, setWhen] = useState('');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Done') : (r.error ?? 'Failed') });
      if (r.ok) {
        setDirty(false);
        router.refresh();
      }
    });

  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[asset.status] ?? 'outline'}>
            {asset.status.toLowerCase()}
          </Badge>
          <span className="text-sm font-medium">
            {asset.title || TYPE_LABEL[asset.type] || asset.type}
          </span>
          <span className="text-muted-foreground text-xs">
            {TYPE_LABEL[asset.type] ?? asset.type} · {asset.platform} · v
            {asset.currentVersionNumber ?? 1} of {asset.versionCount}
          </span>
        </div>
      </div>
      {asset.sourceAngle ? (
        <p className="text-muted-foreground mt-1 text-xs">Angle: {asset.sourceAngle}</p>
      ) : null}

      <Textarea
        className="mt-2 font-mono text-xs"
        rows={Math.min(16, Math.max(4, body.split('\n').length + 1))}
        value={body}
        onChange={(e) => {
          setBody(e.target.value);
          setDirty(true);
        }}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || !dirty}
          onClick={() => run(() => editAssetAction({ assetId: asset.id, projectId, body }))}
        >
          Save edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => run(() => regenerateAssetAction({ assetId: asset.id, projectId }))}
        >
          Regenerate
        </Button>

        {asset.status === 'DRAFT' ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() => run(() => approveAssetAction(asset.id, projectId))}
          >
            Approve
          </Button>
        ) : null}

        {asset.status === 'APPROVED' || asset.status === 'SCHEDULED' ? (
          <>
            <input
              type="datetime-local"
              className="border-input bg-background h-8 rounded-md border px-2 text-xs"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !when}
              onClick={() =>
                run(() => scheduleAssetAction(asset.id, projectId, new Date(when).toISOString()))
              }
            >
              {asset.status === 'SCHEDULED' ? 'Reschedule' : 'Schedule'}
            </Button>
            {asset.status === 'SCHEDULED' ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => run(() => unscheduleAssetAction(asset.id, projectId))}
              >
                Unschedule
              </Button>
            ) : null}
            <Button
              size="sm"
              disabled={pending}
              onClick={() => run(() => markPublishedAction(asset.id, projectId))}
            >
              Mark published
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={pending}
              onClick={() =>
                run(() => markFailedAction(asset.id, projectId, 'Marked failed by user.'))
              }
            >
              Mark failed
            </Button>
          </>
        ) : null}

        {(asset.status === 'PUBLISHED' || asset.status === 'FAILED') && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => run(() => resetAssetAction(asset.id, projectId))}
          >
            Reset to draft
          </Button>
        )}

        {asset.versionCount > 1 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              run(() =>
                revertAssetAction(
                  asset.id,
                  projectId,
                  Math.max(1, (asset.currentVersionNumber ?? 2) - 1),
                ),
              )
            }
          >
            Revert 1 version
          </Button>
        ) : null}
      </div>

      {asset.status === 'SCHEDULED' && asset.scheduledFor ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Scheduled for {new Date(asset.scheduledFor).toLocaleString()}. The engine does not publish
          — mark it published after you post it.
        </p>
      ) : null}
      {asset.status === 'PUBLISHED' && asset.publishedAt ? (
        <p className="text-muted-foreground mt-2 text-xs">
          Marked published {new Date(asset.publishedAt).toLocaleString()} ({asset.publishTarget}).
        </p>
      ) : null}
      {asset.failureReason ? (
        <p className="text-destructive mt-2 text-xs">Failed: {asset.failureReason}</p>
      ) : null}
      {msg ? (
        <p
          role={msg.ok ? 'status' : 'alert'}
          className={`mt-2 text-xs ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
        >
          {msg.text}
        </p>
      ) : null}
    </div>
  );
}

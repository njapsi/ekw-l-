'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Alert,
  AlertDescription,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Textarea,
} from '@growth-agent/ui';
import {
  type DraftInput,
  approveTikTokPublishAction,
  createTikTokDraftAction,
} from '@/server/tiktok-actions';

const PRIVACY: Array<[DraftInput['privacy'], string]> = [
  ['SELF_ONLY', 'Only me (private)'],
  ['FOLLOWER_OF_CREATOR', 'Followers'],
  ['MUTUAL_FOLLOW_FRIENDS', 'Friends (mutual follows)'],
  ['PUBLIC_TO_EVERYONE', 'Public (requires an audited app)'],
];

export function CreateDraftForm({ canPublish }: { canPublish: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState<DraftInput>({
    sourceUrl: '',
    caption: '',
    hashtags: '',
    privacy: 'SELF_ONLY',
  });
  const [result, setResult] = useState<{ ok: boolean; error?: string; message?: string } | null>(
    null,
  );

  if (!canPublish) {
    return (
      <Alert>
        <AlertDescription>
          Publishing needs the <code className="font-mono text-xs">video.publish</code> scope.
          Reconnect TikTok from the integrations page and choose to include publishing.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createTikTokDraftAction(form);
          setResult(r);
          if (r.ok) {
            setForm({ ...form, caption: '', hashtags: '', sourceUrl: '' });
            router.refresh();
          }
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="src">Source video URL (public, https, direct file)</Label>
        <Input
          id="src"
          type="url"
          required
          placeholder="https://cdn.example.com/my-clip.mp4"
          value={form.sourceUrl}
          onChange={(e) => setForm({ ...form, sourceUrl: e.target.value })}
        />
        <p className="text-muted-foreground text-xs">
          Phase 4 uses TikTok’s PULL_FROM_URL source — the URL must be reachable by TikTok.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cap">Caption</Label>
        <Textarea
          id="cap"
          required
          maxLength={2000}
          value={form.caption}
          onChange={(e) => setForm({ ...form, caption: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tags">Hashtags (space or comma separated)</Label>
        <Input
          id="tags"
          placeholder="tutorial howto growth"
          value={form.hashtags}
          onChange={(e) => setForm({ ...form, hashtags: e.target.value })}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="priv">Privacy</Label>
        <select
          id="priv"
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
          value={form.privacy}
          onChange={(e) => setForm({ ...form, privacy: e.target.value as DraftInput['privacy'] })}
        >
          {PRIVACY.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <fieldset className="flex flex-wrap gap-4 text-sm">
        {(['disableComment', 'disableDuet', 'disableStitch'] as const).map((k) => (
          <label key={k} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={Boolean(form[k])}
              onChange={(e) => setForm({ ...form, [k]: e.target.checked })}
            />
            {k.replace('disable', 'Disable ')}
          </label>
        ))}
      </fieldset>
      {result ? (
        <p
          role={result.ok ? 'status' : 'alert'}
          className={result.ok ? 'text-muted-foreground text-sm' : 'text-destructive text-sm'}
        >
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating…' : 'Create draft'}
      </Button>
    </form>
  );
}

export function ApprovePublishButton({
  publishId,
  caption,
  privacy,
}: {
  publishId: string;
  caption: string;
  privacy: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Review &amp; approve</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to TikTok?</DialogTitle>
          <DialogDescription>
            This submits the video to TikTok’s Content Posting API right now. Nothing is published
            until you approve here.
          </DialogDescription>
        </DialogHeader>
        <div className="border-border space-y-2 rounded-md border p-3 text-sm">
          <p className="whitespace-pre-wrap">{caption}</p>
          <p className="text-muted-foreground text-xs">Privacy: {privacy.toLowerCase()}</p>
        </div>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await approveTikTokPublishAction(publishId);
                if (r.ok) {
                  setOpen(false);
                  router.refresh();
                } else {
                  setError(r.error ?? 'Failed to submit.');
                }
              })
            }
          >
            {pending ? 'Submitting…' : 'Approve & publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

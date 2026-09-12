'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Textarea } from '@growth-agent/ui';
import { createRepurposeProjectAction } from '@/server/content-actions';

type Kind = 'youtube_video' | 'video_url' | 'transcript' | 'manual';

export function NewProjectForm({ videos }: { videos: Array<{ id: string; title: string }> }) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>(videos.length ? 'youtube_video' : 'manual');
  const [videoId, setVideoId] = useState(videos[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [transcript, setTranscript] = useState('');
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await createRepurposeProjectAction({
        sourceKind: kind,
        youTubeVideoId: kind === 'youtube_video' ? videoId : undefined,
        url: kind === 'video_url' ? url.trim() : undefined,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        transcript: transcript.trim() || undefined,
        body: body.trim() || undefined,
        name: name.trim() || undefined,
      });
      if (r.ok && r.projectId) router.push(`/app/content/${r.projectId}`);
      else setError(r.error ?? 'Failed');
    });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-1">
        {(
          [
            ['youtube_video', 'Synced YouTube video'],
            ['video_url', 'Video URL + text'],
            ['transcript', 'Transcript'],
            ['manual', 'Paste content'],
          ] as Array<[Kind, string]>
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            disabled={k === 'youtube_video' && videos.length === 0}
            className={`rounded border px-2 py-1 text-xs ${k === kind ? 'bg-muted border-foreground' : 'border-border'} disabled:opacity-40`}
            onClick={() => setKind(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {kind === 'youtube_video' ? (
        <div className="space-y-1">
          <Label htmlFor="vid">Video</Label>
          <select
            id="vid"
            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
            value={videoId}
            onChange={(e) => setVideoId(e.target.value)}
          >
            {videos.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title.slice(0, 90)}
              </option>
            ))}
          </select>
          <p className="text-muted-foreground text-xs">
            Title, description and tags come from the sync. Paste the transcript below for a much
            better analysis.
          </p>
        </div>
      ) : null}

      {kind === 'video_url' ? (
        <div className="space-y-1">
          <Label htmlFor="url">Video URL</Label>
          <Input
            id="url"
            type="url"
            placeholder="https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            The engine does not fetch or transcribe the video. Paste the title / description /
            transcript below.
          </p>
        </div>
      ) : null}

      {(kind === 'video_url' || kind === 'transcript' || kind === 'manual') && (
        <div className="space-y-1">
          <Label htmlFor="title">Title / topic (optional)</Label>
          <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      )}
      {kind === 'video_url' ? (
        <div className="space-y-1">
          <Label htmlFor="desc">Description (optional)</Label>
          <Textarea
            id="desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      ) : null}
      {(kind === 'youtube_video' || kind === 'video_url' || kind === 'transcript') && (
        <div className="space-y-1">
          <Label htmlFor="tr">Transcript {kind === 'transcript' ? '' : '(optional)'}</Label>
          <Textarea
            id="tr"
            rows={6}
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
          />
        </div>
      )}
      {kind === 'manual' ? (
        <div className="space-y-1">
          <Label htmlFor="body">Source content</Label>
          <Textarea id="body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
      ) : null}

      <div className="space-y-1">
        <Label htmlFor="name">Project name (optional)</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create project'}
        </Button>
        {error ? (
          <span role="alert" className="text-destructive text-sm">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

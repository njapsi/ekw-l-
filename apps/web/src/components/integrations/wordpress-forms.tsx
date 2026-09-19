'use client';

import { useState } from 'react';
import { Button, Input, Label, Textarea } from '@growth-agent/ui';
import {
  type ActionResult,
  connectWordPressAction,
  createWordPressDraftAction,
  requestWordPressChangeAction,
} from '@/server/integration-actions';

function Outcome({ result }: { result: ActionResult | null }) {
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {result ? (
        <p className={result.ok ? 'text-muted-foreground' : 'text-destructive'}>
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </div>
  );
}

export function WordPressConnectForm() {
  const [siteUrl, setSiteUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function submit() {
    setPending(true);
    setResult(null);
    const r = await connectWordPressAction({ siteUrl, username, applicationPassword: password });
    setResult(r);
    if (r.ok) setPassword('');
    setPending(false);
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="wp-url">Site address</Label>
        <Input
          id="wp-url"
          placeholder="https://blog.example.com"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          autoComplete="url"
          required
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="wp-user">WordPress username</Label>
          <Input
            id="wp-user"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wp-pass">Application password</Label>
          <Input
            id="wp-pass"
            type="password"
            placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Create one in WordPress under <strong>Users → Profile → Application Passwords</strong>. Do
        not use your login password. It is verified with your site before anything is saved,
        encrypted at rest, and never sent back to your browser.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? 'Verifying with WordPress…' : 'Connect WordPress'}
      </Button>
      <Outcome result={result} />
    </form>
  );
}

export function WordPressDraftForm({ siteId }: { siteId: string }) {
  const [kind, setKind] = useState<'posts' | 'pages'>('posts');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function submit() {
    setPending(true);
    setResult(null);
    const r = await createWordPressDraftAction({ siteId, kind, title, content, excerpt });
    setResult(r);
    if (r.ok) {
      setTitle('');
      setContent('');
      setExcerpt('');
    }
    setPending(false);
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="wp-kind">Type</Label>
        <select
          id="wp-kind"
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value === 'pages' ? 'pages' : 'posts')}
        >
          <option value="posts">Post</option>
          <option value="pages">Page</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wp-title">Title</Label>
        <Input id="wp-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wp-content">Content</Label>
        <Textarea
          id="wp-content"
          rows={6}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="wp-excerpt">Excerpt (optional)</Label>
        <Input id="wp-excerpt" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Creating draft…' : 'Create draft in WordPress'}
      </Button>
      <p className="text-muted-foreground text-xs">
        Drafts are not visible to the public. Publishing always needs an admin&apos;s approval.
      </p>
      <Outcome result={result} />
    </form>
  );
}

/** Ask for a publish or an edit of one item. Creates a pending approval only. */
export function WordPressChangeRequest({
  siteId,
  wpId,
  kind,
  title,
  canPublish,
  canEdit,
}: {
  siteId: string;
  wpId: number;
  kind: 'posts' | 'pages';
  title: string;
  canPublish: boolean;
  canEdit: boolean;
}) {
  const [newTitle, setNewTitle] = useState(title);
  const [newExcerpt, setNewExcerpt] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function request(capabilityId: 'wordpress.publish' | 'wordpress.update_post') {
    setPending(true);
    setResult(null);
    const payload: Record<string, unknown> = { kind, wpId };
    if (capabilityId === 'wordpress.update_post') {
      if (newTitle.trim() && newTitle !== title) payload.title = newTitle.trim();
      if (newExcerpt.trim()) payload.excerpt = newExcerpt.trim();
    }
    setResult(
      await requestWordPressChangeAction({
        siteId,
        capabilityId,
        payload,
        summary:
          capabilityId === 'wordpress.publish'
            ? `Publish "${title}"`
            : `Edit "${title}"${payload.title ? ` → title "${String(payload.title)}"` : ''}`,
      }),
    );
    setPending(false);
  }

  return (
    <div className="space-y-2">
      {canPublish ? (
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => void request('wordpress.publish')}
        >
          Request publish
        </Button>
      ) : null}
      {canEdit ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs">Propose an edit</summary>
          <div className="mt-2 space-y-2">
            <Input
              aria-label="New title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
            />
            <Input
              aria-label="New excerpt"
              placeholder="New excerpt (optional)"
              value={newExcerpt}
              onChange={(e) => setNewExcerpt(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => void request('wordpress.update_post')}
            >
              Request edit
            </Button>
          </div>
        </details>
      ) : null}
      <Outcome result={result} />
    </div>
  );
}

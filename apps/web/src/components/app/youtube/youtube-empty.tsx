import Link from 'next/link';
import { AlertTriangle, Youtube } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button, EmptyState } from '@growth-agent/ui';
import type { YouTubeState } from '@/lib/youtube-state';
import { SyncButton } from './youtube-actions';

export function YouTubeEmpty({ state }: { state: Exclude<YouTubeState, { kind: 'ready' }> }) {
  if (state.kind === 'not_configured') {
    return (
      <EmptyState
        icon={<Youtube />}
        title="YouTube isn’t configured on this deployment yet."
        description="An administrator needs to set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, and ENCRYPTION_KEY. Until then, YouTube analysis is unavailable — no sample data is shown."
      />
    );
  }

  if (state.kind === 'not_connected') {
    return (
      <EmptyState
        icon={<Youtube />}
        title="Connect YouTube to begin analyzing your channel."
        description="We use the official YouTube Data and Analytics APIs with read-only access. Nothing is analyzed until you connect, and we never invent metrics an API did not return."
        action={
          <Button asChild>
            <a href="/api/integrations/youtube/connect">Connect YouTube</a>
          </Button>
        }
      />
    );
  }

  if (state.kind === 'connection_error') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>YouTube access needs attention</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{state.connection.lastError ?? 'The connection could not be refreshed.'}</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/app/integrations/youtube">Reconnect on the integrations page</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // not_synced
  return (
    <EmptyState
      icon={<Youtube />}
      title="Connected — run your first sync."
      description="Your channel is linked but no data has been pulled yet. Syncing fetches channel info, recent videos, and daily analytics from YouTube."
      action={<SyncButton>Sync now</SyncButton>}
    />
  );
}

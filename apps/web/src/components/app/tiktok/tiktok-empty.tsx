import Link from 'next/link';
import { AlertTriangle, Music2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle, Button, EmptyState } from '@growth-agent/ui';
import type { TikTokState } from '@/lib/tiktok-state';
import { TikTokSyncButton } from './tiktok-actions';

export function TikTokEmpty({ state }: { state: Exclude<TikTokState, { kind: 'ready' }> }) {
  if (state.kind === 'not_configured') {
    return (
      <EmptyState
        icon={<Music2 />}
        title="TikTok isn’t configured on this deployment yet."
        description="An administrator needs to set TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, and ENCRYPTION_KEY. Until then, TikTok analysis is unavailable — no sample data is shown."
      />
    );
  }
  if (state.kind === 'not_connected') {
    return (
      <EmptyState
        icon={<Music2 />}
        title="Connect TikTok to begin analyzing your profile."
        description="We use the official TikTok API. The public API exposes limited analytics — anything it does not return is shown as unavailable, never estimated."
        action={
          <Button asChild>
            <a href="/api/integrations/tiktok/connect">Connect TikTok</a>
          </Button>
        }
      />
    );
  }
  if (state.kind === 'connection_error') {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>TikTok access needs attention</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{state.connection.lastError ?? 'The connection could not be refreshed.'}</p>
          <Button asChild size="sm" variant="outline">
            <Link href="/app/integrations/tiktok">Reconnect on the integrations page</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <EmptyState
      icon={<Music2 />}
      title="Connected — run your first sync."
      description="Your account is linked but no data has been pulled yet. Syncing fetches profile info and your recent videos from the official API."
      action={<TikTokSyncButton>Sync now</TikTokSyncButton>}
    />
  );
}

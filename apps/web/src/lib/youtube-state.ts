import 'server-only';
import { youtube } from '@growth-agent/services';
import { youtubeConfigured } from '@/lib/youtube';

type ConnectionSummary = NonNullable<Awaited<ReturnType<typeof youtube.getConnectionSummary>>>;
type Overview = NonNullable<Awaited<ReturnType<typeof youtube.getChannelOverview>>>;

export type YouTubeState =
  | { kind: 'not_configured' }
  | { kind: 'not_connected' }
  | { kind: 'connection_error'; connection: ConnectionSummary }
  | { kind: 'not_synced'; connection: ConnectionSummary }
  | { kind: 'ready'; connection: ConnectionSummary; overview: Overview };

export async function loadYouTubeState(organizationId: string): Promise<YouTubeState> {
  if (!youtubeConfigured()) return { kind: 'not_configured' };

  const connection = await youtube.getConnectionSummary(organizationId);
  if (!connection || connection.status === 'REVOKED') return { kind: 'not_connected' };

  const overview = await youtube.getChannelOverview(organizationId);
  if (connection.status === 'ERROR' && !overview) {
    return { kind: 'connection_error', connection };
  }
  if (!overview) return { kind: 'not_synced', connection };
  return { kind: 'ready', connection, overview };
}

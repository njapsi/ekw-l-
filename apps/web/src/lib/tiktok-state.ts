import 'server-only';
import { tiktok } from '@growth-agent/services';
import { tiktokConfigured } from '@/lib/tiktok';

type ConnectionSummary = NonNullable<Awaited<ReturnType<typeof tiktok.getConnectionSummary>>>;
type Overview = NonNullable<Awaited<ReturnType<typeof tiktok.getAccountOverview>>>;

export type TikTokState =
  | { kind: 'not_configured' }
  | { kind: 'not_connected' }
  | { kind: 'connection_error'; connection: ConnectionSummary }
  | { kind: 'not_synced'; connection: ConnectionSummary }
  | { kind: 'ready'; connection: ConnectionSummary; overview: Overview };

export async function loadTikTokState(organizationId: string): Promise<TikTokState> {
  if (!tiktokConfigured()) return { kind: 'not_configured' };
  const connection = await tiktok.getConnectionSummary(organizationId);
  if (!connection || connection.status === 'REVOKED') return { kind: 'not_connected' };
  const overview = await tiktok.getAccountOverview(organizationId);
  if (connection.status === 'ERROR' && !overview) return { kind: 'connection_error', connection };
  if (!overview) return { kind: 'not_synced', connection };
  return { kind: 'ready', connection, overview };
}

import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { runYouTubeAnalyst } from './analyst.js';
import { ResilientYouTubeClient } from './resilient-client.js';
import { type SyncResult, runFullSync, syncAnalytics, syncChannel, syncVideos } from './sync.js';

export interface YouTubeJobContext {
  organizationId: string;
  connectionId: string;
  /** The OAuth redirect URI (needed for token refresh). */
  redirectUri: string;
}

async function loadConnection(ctx: YouTubeJobContext, db: Db) {
  const connection = await db.oAuthConnection.findUnique({ where: { id: ctx.connectionId } });
  if (!connection || connection.organizationId !== ctx.organizationId) {
    throw AppError.notFound('Connection');
  }
  if (connection.provider !== 'YOUTUBE') throw AppError.validation('Not a YouTube connection.');
  return connection;
}

/** Full sync: discover channels, then channel + videos + analytics for each. */
export async function runYouTubeFullSync(
  ctx: YouTubeJobContext,
  db: Db = prisma,
): Promise<SyncResult[]> {
  const connection = await loadConnection(ctx, db);
  const client = new ResilientYouTubeClient(connection, ctx.redirectUri, db);
  return runFullSync(client, {
    db,
    organizationId: ctx.organizationId,
    connection: { id: connection.id, scopes: connection.scopes, status: connection.status },
  });
}

/** Sync one facet for one stored channel (used by the "sync now" buttons). */
export async function runYouTubeChannelSync(
  ctx: YouTubeJobContext & { channelId: string; facet: 'channel' | 'videos' | 'analytics' | 'all' },
  db: Db = prisma,
): Promise<SyncResult[]> {
  const connection = await loadConnection(ctx, db);
  const channel = await db.youTubeChannel.findFirst({
    where: { id: ctx.channelId, organizationId: ctx.organizationId },
  });
  if (!channel) throw AppError.notFound('YouTube channel');
  const client = new ResilientYouTubeClient(connection, ctx.redirectUri, db);
  const sctx = {
    db,
    organizationId: ctx.organizationId,
    connection: { id: connection.id, scopes: connection.scopes, status: connection.status },
  };
  const results: SyncResult[] = [];
  if (ctx.facet === 'channel' || ctx.facet === 'all')
    results.push(await syncChannel(client, sctx, channel));
  if (ctx.facet === 'videos' || ctx.facet === 'all')
    results.push(await syncVideos(client, sctx, channel));
  if (ctx.facet === 'analytics' || ctx.facet === 'all')
    results.push(await syncAnalytics(client, sctx, channel));
  return results;
}

/** Run the YouTube Analyst Agent for a stored channel. */
export async function runYouTubeAnalystJob(
  input: { organizationId: string; channelId: string; trigger?: string },
  db: Db = prisma,
) {
  const registry = createRegistryFromEnv();
  let model;
  try {
    model = registry.getForRole('analyst').provider;
  } catch {
    throw new AppError(
      'provider_unavailable',
      'No AI provider is configured. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY) to run the analyst.',
    );
  }
  return runYouTubeAnalyst({ db, model }, input);
}

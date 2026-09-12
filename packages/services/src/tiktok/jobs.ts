import { createRegistryFromEnv } from '@growth-agent/ai';
import { type Db, prisma } from '@growth-agent/db';
import { AppError } from '../errors.js';
import { runTikTokAnalyst } from './analyst.js';
import {
  type ApproveInput,
  type CreateDraftInput,
  approveAndSubmit,
  createPublishDraft,
  refreshPublishStatus,
} from './publish.js';
import { ResilientTikTokClient } from './resilient-client.js';
import { type TikTokSyncResult, runFullSync, syncAccount, syncVideos } from './sync.js';

export interface TikTokJobContext {
  organizationId: string;
  connectionId: string;
  redirectUri: string;
}

async function loadConnection(ctx: TikTokJobContext, db: Db) {
  const connection = await db.oAuthConnection.findUnique({ where: { id: ctx.connectionId } });
  if (!connection || connection.organizationId !== ctx.organizationId)
    throw AppError.notFound('Connection');
  if (connection.provider !== 'TIKTOK') throw AppError.validation('Not a TikTok connection.');
  return connection;
}

export async function runTikTokFullSync(
  ctx: TikTokJobContext,
  db: Db = prisma,
): Promise<TikTokSyncResult[]> {
  const connection = await loadConnection(ctx, db);
  const client = new ResilientTikTokClient(connection, ctx.redirectUri, db);
  return runFullSync(client, {
    db,
    organizationId: ctx.organizationId,
    connection: { id: connection.id, scopes: connection.scopes, status: connection.status },
  });
}

export async function runTikTokAccountSync(
  ctx: TikTokJobContext & { accountId: string; facet: 'account' | 'videos' | 'all' },
  db: Db = prisma,
): Promise<TikTokSyncResult[]> {
  const connection = await loadConnection(ctx, db);
  const account = await db.tikTokAccount.findFirst({
    where: { id: ctx.accountId, organizationId: ctx.organizationId },
  });
  if (!account) throw AppError.notFound('TikTok account');
  const client = new ResilientTikTokClient(connection, ctx.redirectUri, db);
  const sctx = {
    db,
    organizationId: ctx.organizationId,
    connection: { id: connection.id, scopes: connection.scopes, status: connection.status },
  };
  const out: TikTokSyncResult[] = [];
  if (ctx.facet === 'account' || ctx.facet === 'all')
    out.push(await syncAccount(client, sctx, account));
  if (ctx.facet === 'videos' || ctx.facet === 'all')
    out.push(await syncVideos(client, sctx, account));
  return out;
}

export async function runTikTokAnalystJob(
  input: { organizationId: string; accountId: string; trigger?: string },
  db: Db = prisma,
) {
  const registry = createRegistryFromEnv();
  let model;
  try {
    model = registry.getForRole('analyst').provider;
  } catch {
    throw new AppError(
      'provider_unavailable',
      'No AI provider is configured. Set an API key to run the TikTok analyst.',
    );
  }
  return runTikTokAnalyst({ db, model }, input);
}

// --- publishing job wrappers ---------------------------------------------

export const createTikTokDraft = createPublishDraft;

export async function approveTikTokPublish(ctx: TikTokJobContext & ApproveInput, db: Db = prisma) {
  const connection = await loadConnection(ctx, db);
  const client = new ResilientTikTokClient(connection, ctx.redirectUri, db);
  return approveAndSubmit(
    {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      publishId: ctx.publishId,
      approve: ctx.approve,
    },
    client,
    db,
  );
}

export async function refreshTikTokPublishStatus(
  ctx: TikTokJobContext & { publishRowId: string },
  db: Db = prisma,
) {
  const connection = await loadConnection(ctx, db);
  const client = new ResilientTikTokClient(connection, ctx.redirectUri, db);
  return refreshPublishStatus(ctx.organizationId, ctx.publishRowId, client, db);
}

export type { CreateDraftInput };

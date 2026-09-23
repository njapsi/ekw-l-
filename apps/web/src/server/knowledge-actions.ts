'use server';

import { revalidatePath } from 'next/cache';
import { agent, isAppError, knowledge, security } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
  knowledgeId?: string;
}

function toError(e: unknown): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: 'Something went wrong. Please try again.' };
}

function refresh(knowledgeId?: string) {
  revalidatePath('/app/knowledge');
  if (knowledgeId) revalidatePath(`/app/knowledge/${knowledgeId}`);
}

async function limited(key: string, limit: number, windowSec: number): Promise<ActionResult | null> {
  const rl = await security.checkRateLimit({ key, limit, windowSec });
  return rl.ok ? null : { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };
}

export async function createKnowledgeItemAction(
  input: Parameters<typeof knowledge.createKnowledgeItem>[0],
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    const rl = await limited(`knowledge-create:${org.id}:${user.id}`, 40, 3600);
    if (rl) return rl;
    const item = await knowledge.createKnowledgeItem(input, { organizationId: org.id, createdById: user.id });
    refresh();
    return { ok: true, message: 'Knowledge item created.', knowledgeId: item.id };
  } catch (e) {
    return toError(e);
  }
}

/** Text- or URL-based document ingestion (Phase 11, §13-14). */
export async function ingestDocumentAction(
  input: Parameters<typeof knowledge.ingestDocument>[0],
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    const rl = await limited(`knowledge-ingest:${org.id}:${user.id}`, 20, 3600);
    if (rl) return rl;
    const deps = agent.growthAgentDepsFromEnv({ organizationId: org.id, actorId: user.id });
    const result = await knowledge.ingestDocument(input, {
      organizationId: org.id,
      createdById: user.id,
      model: deps.embeddingModel,
    });
    refresh();
    return {
      ok: true,
      message: `Ingested ${result.chunkCount} chunk(s)${result.embeddedCount > 0 ? `, ${result.embeddedCount} embedded` : ' (no embedding provider configured — keyword search still works)'}.`,
      knowledgeId: result.knowledgeId,
    };
  } catch (e) {
    return toError(e);
  }
}

export async function updateKnowledgeItemAction(
  knowledgeId: string,
  input: Parameters<typeof knowledge.updateKnowledgeItem>[2],
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    await knowledge.updateKnowledgeItem(org.id, knowledgeId, input, user.id);
    refresh(knowledgeId);
    return { ok: true, message: 'Knowledge item updated.' };
  } catch (e) {
    return toError(e);
  }
}

export async function verifyKnowledgeItemAction(knowledgeId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    await knowledge.verifyKnowledgeItem(org.id, knowledgeId, user.id);
    refresh(knowledgeId);
    return { ok: true, message: 'Marked as verified.' };
  } catch (e) {
    return toError(e);
  }
}

export async function archiveKnowledgeItemAction(knowledgeId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    await knowledge.archiveKnowledgeItem(org.id, knowledgeId, user.id);
    refresh(knowledgeId);
    return { ok: true, message: 'Archived.' };
  } catch (e) {
    return toError(e);
  }
}

export async function deleteKnowledgeItemAction(knowledgeId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    await knowledge.deleteKnowledgeItem(org.id, knowledgeId, user.id);
    refresh();
    return { ok: true, message: 'Deleted.' };
  } catch (e) {
    return toError(e);
  }
}

export async function acceptMemoryCandidateAction(candidateId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('memory.manage');
    const row = await knowledge.acceptMemoryCandidate(org.id, candidateId, user.id);
    revalidatePath('/app/knowledge/memories');
    return { ok: true, message: 'Accepted.', knowledgeId: row.resolvedKnowledgeId ?? undefined };
  } catch (e) {
    return toError(e);
  }
}

export async function rejectMemoryCandidateAction(candidateId: string): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('memory.manage');
    await knowledge.rejectMemoryCandidate(org.id, candidateId, user.id);
    revalidatePath('/app/knowledge/memories');
    return { ok: true, message: 'Rejected.' };
  } catch (e) {
    return toError(e);
  }
}

export async function resolveConflictAction(
  conflictId: string,
  input: { resolution: string; keepKnowledgeId?: string; status: 'RESOLVED' | 'DISMISSED' },
): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('knowledge.manage');
    await knowledge.resolveConflict(org.id, conflictId, input, user.id);
    revalidatePath('/app/knowledge/conflicts');
    return { ok: true, message: 'Conflict resolved.' };
  } catch (e) {
    return toError(e);
  }
}

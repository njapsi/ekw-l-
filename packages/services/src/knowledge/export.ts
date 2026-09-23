/** Part 60: knowledge export. Mirrors `agent/conversations.ts::exportConversation`'s
 * shape/convention — JSON only for this phase (CSV/Markdown exporters are
 * disclosed as deferred in docs/KNOWLEDGE-INTELLIGENCE.md; a knowledge item's
 * content is free text, not tabular, so CSV adds little over JSON here). */
import { type Db, prisma } from '@growth-agent/db';
import { getKnowledgeItem } from './items.js';
import { listEvidenceForKnowledge } from './evidence.js';

export interface KnowledgeExport {
  filename: string;
  content: string;
}

export async function exportKnowledgeItem(
  organizationId: string,
  knowledgeId: string,
  db: Db = prisma,
): Promise<KnowledgeExport> {
  const item = await getKnowledgeItem(organizationId, knowledgeId, db);
  const evidence = await listEvidenceForKnowledge(organizationId, knowledgeId, db);
  const slug =
    item.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'knowledge-item';

  return {
    filename: `${slug}.json`,
    content: JSON.stringify(
      {
        id: item.id,
        type: item.type,
        scope: item.scope,
        title: item.title,
        content: item.content,
        summary: item.summary,
        classification: item.classification,
        confidence: item.confidence,
        importance: item.importance,
        status: item.status,
        primarySource: item.primarySource
          ? { url: item.primarySource.url, title: item.primarySource.title, trustLevel: item.primarySource.trustLevel }
          : null,
        evidence: evidence.map((e) => ({ claim: e.claim, evidence: e.evidence, confidence: e.confidence })),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        lastVerifiedAt: item.lastVerifiedAt,
        expiresAt: item.expiresAt,
      },
      null,
      2,
    ),
  };
}

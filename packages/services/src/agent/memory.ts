/**
 * Controlled long-term memory for the Growth Agent (master instruction:
 * "MEMORY"). Stores exactly six kinds — user goals, org goals, preferences,
 * past recommendations, completed tasks, active projects — and nothing else.
 *
 * "Do not store sensitive information unnecessarily" is enforced at write time:
 *   - only the allowlisted kinds
 *   - values are length-capped (300 chars) and label-capped (60)
 *   - a redaction pass drops anything that looks like an email, phone number,
 *     long digit run, API key / token, or URL credential
 *   - the model extractor is constrained by `MemoryExtraction` (no free-form
 *     kinds) and its output is re-validated here
 */
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { UNTRUSTED_CONTENT_SYSTEM_CLAUSE, wrapUntrusted } from '../security/untrusted.js';
import type { AgentModel } from './capabilities.js';
import { MemoryExtraction } from './schemas.js';

const log = createLogger('agent.memory');

export interface AgentMemory {
  userGoals: string[];
  orgGoals: string[];
  preferences: string[];
  activeProjects: string[];
  pastRecommendations: Array<{ title: string; domain: string; createdAt: Date }>;
  completedTasks: Array<{ title: string; completedAt: Date | null }>;
}

const MAX_VALUE = 300;
const MAX_LABEL = 60;

const SENSITIVE_PATTERNS: RegExp[] = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/, // email
  /\b(?:\+?\d[\s-]?){9,}\b/, // phone / long digit run
  /\b(?:sk|pk|rk|ghp|xox[bप]|AIza|AKIA)[-_A-Za-z0-9]{10,}\b/, // API keys / tokens
  /\b[A-Fa-f0-9]{32,}\b/, // hex secrets
  /https?:\/\/[^\s]*:[^\s]*@/, // URL with credentials
  /\b(password|passwd|secret|api[_-]?key|token|ssn|credit\s?card)\b/i,
];

/** true ⇒ the text must NOT be persisted. */
export function looksSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}

function sanitize(text: string, max: number): string | null {
  const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, max);
  if (trimmed.length < 3) return null;
  if (looksSensitive(trimmed)) return null;
  return trimmed;
}

export async function loadMemory(
  organizationId: string,
  userId: string,
  db: Db = prisma,
): Promise<AgentMemory> {
  const now = new Date();
  const [rows, recs, tasks] = await Promise.all([
    db.orgMemory.findMany({
      where: {
        organizationId,
        OR: [{ userId }, { userId: null }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 100,
    }),
    db.recommendation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: 15,
      select: { title: true, domain: true, createdAt: true },
    }),
    db.task.findMany({
      where: { organizationId, status: 'DONE' },
      orderBy: { completedAt: 'desc' },
      take: 15,
      select: { title: true, completedAt: true },
    }),
  ]);

  const byKind = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.value);
  return {
    userGoals: byKind('USER_GOAL'),
    orgGoals: byKind('ORG_GOAL'),
    preferences: byKind('PREFERENCE'),
    activeProjects: byKind('ACTIVE_PROJECT'),
    pastRecommendations: recs,
    completedTasks: tasks,
  };
}

export function summarizeMemory(m: AgentMemory): string {
  const parts: string[] = [];
  if (m.userGoals.length) parts.push(`Your goals: ${m.userGoals.join('; ')}.`);
  if (m.orgGoals.length) parts.push(`Org goals: ${m.orgGoals.join('; ')}.`);
  if (m.preferences.length) parts.push(`Preferences: ${m.preferences.join('; ')}.`);
  if (m.activeProjects.length) parts.push(`Active projects: ${m.activeProjects.join('; ')}.`);
  if (m.completedTasks.length)
    parts.push(
      `Recently completed: ${m.completedTasks
        .slice(0, 5)
        .map((t) => t.title)
        .join('; ')}.`,
    );
  return parts.join(' ') || 'No stored goals or preferences yet.';
}

/** Upsert one memory row, deduping on (organizationId, userId, kind, label). */
export async function rememberItem(
  input: {
    organizationId: string;
    userId: string | null;
    kind:
      | 'USER_GOAL'
      | 'ORG_GOAL'
      | 'PREFERENCE'
      | 'ACTIVE_PROJECT'
      | 'COMPLETED_TASK'
      | 'PAST_RECOMMENDATION';
    label: string;
    value: string;
    sourceType?: string;
    sourceId?: string;
    confidence?: number;
    expiresAt?: Date;
  },
  db: Db = prisma,
): Promise<boolean> {
  const value = sanitize(input.value, MAX_VALUE);
  const label = sanitize(input.label, MAX_LABEL);
  if (!value || !label) {
    log.info({ kind: input.kind }, 'memory item rejected (empty or sensitive)');
    return false;
  }
  const existing = await db.orgMemory.findFirst({
    where: { organizationId: input.organizationId, userId: input.userId, kind: input.kind, label },
  });
  if (existing) {
    await db.orgMemory.update({
      where: { id: existing.id },
      data: {
        value,
        confidence: input.confidence ?? existing.confidence,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        expiresAt: input.expiresAt ?? null,
      },
    });
  } else {
    await db.orgMemory.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        kind: input.kind,
        label,
        value,
        sourceType: input.sourceType ?? 'manual',
        sourceId: input.sourceId,
        confidence: input.confidence ?? 1,
        expiresAt: input.expiresAt ?? null,
      },
    });
  }
  return true;
}

const GOAL_RE = /\b(?:my|our) (?:goal|aim|objective|target) is (?:to )?([^.!?\n]{4,180})/i;
const WANT_RE = /\bI (?:want|need|would like) (?:to )?([^.!?\n]{4,180})/i;
const PREFER_RE = /\bI (?:prefer|like it when|always|usually) ([^.!?\n]{4,180})/i;

export interface RememberDeps {
  db?: Db;
  model?: AgentModel;
}

/**
 * Extract durable goals / preferences / projects from the user's message. The
 * model path is constrained by `MemoryExtraction`; a deterministic regex path
 * runs when there is no model. Nothing sensitive is stored.
 */
export async function rememberFromTurn(
  deps: RememberDeps,
  input: { organizationId: string; userId: string; message: string; conversationId: string },
): Promise<number> {
  const db = deps.db ?? prisma;
  let stored = 0;

  const persist = async (
    kind: 'USER_GOAL' | 'PREFERENCE' | 'ACTIVE_PROJECT',
    label: string,
    value: string,
    confidence: number,
  ) => {
    const ok = await rememberItem(
      {
        organizationId: input.organizationId,
        userId: input.userId,
        kind,
        label,
        value,
        sourceType: 'conversation',
        sourceId: input.conversationId,
        confidence,
      },
      db,
    );
    if (ok) stored++;
  };

  if (deps.model) {
    try {
      const res = await deps.model.generateObject({
        schema: MemoryExtraction,
        system:
          'Extract ONLY durable user goals, organization goals, preferences, or active projects that the user explicitly stated in their message. If none, return an empty list. Never include names, emails, numbers, credentials, or anything sensitive. Keep each value under 300 characters.\n\n' +
          UNTRUSTED_CONTENT_SYSTEM_CLAUSE,
        prompt: `${wrapUntrusted('USER_MESSAGE', input.message)}\n\nReturn the memory items stated in the user message above.`,
      });
      for (const item of res.object.items) {
        // Org goals are set manually only; downgrade any extracted ORG_GOAL.
        const kind = item.kind === 'ORG_GOAL' ? 'USER_GOAL' : item.kind;
        await persist(kind, item.label, item.value, item.confidence);
      }
      return stored;
    } catch (e) {
      log.warn({ err: String(e) }, 'model memory extraction failed; using regex');
    }
  }

  const g = GOAL_RE.exec(input.message);
  if (g?.[1]) await persist('USER_GOAL', 'primary-goal', g[1].trim(), 0.7);
  const w = WANT_RE.exec(input.message);
  if (w?.[1] && !g) await persist('USER_GOAL', 'stated-want', w[1].trim(), 0.6);
  const p = PREFER_RE.exec(input.message);
  if (p?.[1]) await persist('PREFERENCE', 'stated-preference', p[1].trim(), 0.6);
  return stored;
}

/** Called when a task is completed. */
export async function recordCompletedTask(
  input: { organizationId: string; taskId: string; title: string },
  db: Db = prisma,
): Promise<void> {
  await rememberItem(
    {
      organizationId: input.organizationId,
      userId: null,
      kind: 'COMPLETED_TASK',
      label: `task-${input.taskId}`,
      value: input.title,
      sourceType: 'task',
      sourceId: input.taskId,
    },
    db,
  );
}

import { describe, expect, it, vi } from 'vitest';
import { isAppError } from '../errors.js';
import { TikTokPublishError, type TikTokClient } from './client.js';
import {
  approveAndSubmit,
  composeCaption,
  createPublishDraft,
  refreshPublishStatus,
} from './publish.js';

// --- in-memory fake db --------------------------------------------------

function makeDb(opts: { scopes: string[]; connectionStatus?: string }) {
  const publishes: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    publishes,
    audits,
    tikTokAccount: {
      findFirst: vi.fn(async () => ({
        id: 'acc_1',
        organizationId: 'org_1',
        openId: 'open_1',
        connection: { status: opts.connectionStatus ?? 'ACTIVE', scopes: opts.scopes },
      })),
    },
    tikTokPublish: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return (
          publishes.find((p) => {
            for (const [k, v] of Object.entries(where)) {
              if (k === 'status' && typeof v === 'object' && v && 'in' in (v as object)) {
                if (!(v as { in: string[] }).in.includes(p.status as string)) return false;
              } else if (k === 'id' && typeof v === 'object' && v && 'not' in (v as object)) {
                if (p.id === (v as { not: string }).not) return false;
              } else if (p[k] !== v) {
                return false;
              }
            }
            return true;
          }) ?? null
        );
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `pub_${seq++}`, createdAt: new Date(), ...data };
        publishes.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = publishes.find((p) => p.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      ),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return {};
      }),
    },
  };
}

const draftInput = {
  organizationId: 'org_1',
  userId: 'usr_1',
  accountId: 'acc_1',
  sourceUrl: 'https://cdn.example.com/clip.mp4',
  caption: 'my first post',
  hashtags: ['howto', 'growth'],
  privacy: 'SELF_ONLY' as const,
};

describe('tiktok publish', () => {
  it('composeCaption appends unique hashtags', () => {
    expect(composeCaption('hello', ['a', '#a', 'b'])).toBe('hello\n\n#a #b');
  });

  it('requires the video.publish scope', async () => {
    const db = makeDb({ scopes: ['video.list'] });
    const err = await createPublishDraft(draftInput, db as never).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('permission_denied');
  });

  it('rejects a non-https source URL', async () => {
    const db = makeDb({ scopes: ['video.publish'] });
    const err = await createPublishDraft(
      { ...draftInput, sourceUrl: 'http://insecure/clip.mp4' },
      db as never,
    ).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('validation_failed');
  });

  it('creates an AWAITING_APPROVAL draft and blocks an equivalent duplicate', async () => {
    const db = makeDb({ scopes: ['video.publish'] });
    const draft = await createPublishDraft(draftInput, db as never);
    expect(draft.status).toBe('AWAITING_APPROVAL');

    const err = await createPublishDraft(draftInput, db as never).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('conflict');
    expect(db.publishes).toHaveLength(1);
  });

  it('refuses to submit without explicit approval (never silently publishes)', async () => {
    const db = makeDb({ scopes: ['video.publish'] });
    const draft = await createPublishDraft(draftInput, db as never);
    const client = { initDirectPost: vi.fn() } as unknown as TikTokClient;

    const err = await approveAndSubmit(
      { organizationId: 'org_1', userId: 'usr_1', publishId: draft.id, approve: false },
      client,
      db as never,
    ).catch((e) => e);
    expect(isAppError(err) && err.code).toBe('automation_disabled');
    expect(client.initDirectPost).not.toHaveBeenCalled();
    expect((db.publishes[0] as { status: string }).status).toBe('AWAITING_APPROVAL');
  });

  it('submits to the Content Posting API on explicit approval and records audit', async () => {
    const db = makeDb({ scopes: ['video.publish'] });
    const draft = await createPublishDraft(draftInput, db as never);
    const client = {
      initDirectPost: vi.fn(async () => ({
        data: { publish_id: 'tt_pub_1' },
        error: { code: 'ok' },
      })),
    } as unknown as TikTokClient;

    const res = await approveAndSubmit(
      { organizationId: 'org_1', userId: 'usr_1', publishId: draft.id, approve: true },
      client,
      db as never,
    );
    expect(client.initDirectPost).toHaveBeenCalledOnce();
    expect(res.status).toBe('PROCESSING');
    expect(res.publishId).toBe('tt_pub_1');
    expect(db.audits.map((a) => a.action)).toContain('tiktok.publish.approved');
  });

  it('marks the publish FAILED and rethrows on an API publish error', async () => {
    const db = makeDb({ scopes: ['video.publish'] });
    const draft = await createPublishDraft(draftInput, db as never);
    const client = {
      initDirectPost: vi.fn(async () => {
        throw new TikTokPublishError('spam risk', 'spam_risk_too_many_pending_share');
      }),
    } as unknown as TikTokClient;

    await expect(
      approveAndSubmit(
        { organizationId: 'org_1', userId: 'usr_1', publishId: draft.id, approve: true },
        client,
        db as never,
      ),
    ).rejects.toBeInstanceOf(TikTokPublishError);
    expect((db.publishes[0] as { status: string; error: string }).status).toBe('FAILED');
    expect(db.audits.map((a) => a.action)).toContain('tiktok.publish.failed');
  });

  it('advances to PUBLISHED when TikTok reports PUBLISH_COMPLETE', async () => {
    const db = makeDb({ scopes: ['video.publish'] });
    const draft = await createPublishDraft(draftInput, db as never);
    const client = {
      initDirectPost: vi.fn(async () => ({ data: { publish_id: 'tt_1' }, error: { code: 'ok' } })),
      fetchPublishStatus: vi.fn(async () => ({
        data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7000'] },
        error: { code: 'ok' },
      })),
    } as unknown as TikTokClient;

    await approveAndSubmit(
      { organizationId: 'org_1', userId: 'usr_1', publishId: draft.id, approve: true },
      client,
      db as never,
    );
    const updated = await refreshPublishStatus('org_1', draft.id, client, db as never);
    expect(updated.status).toBe('PUBLISHED');
  });
});

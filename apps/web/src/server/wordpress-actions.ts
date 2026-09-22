'use server';

import { revalidatePath } from 'next/cache';
import { isAppError, security, wordpress } from '@growth-agent/services';
import { requirePermission } from '@/lib/auth';

export interface ActionResult {
  ok: boolean;
  message?: string;
  error?: string;
}

function toError(e: unknown, fallback = 'Something went wrong. Please try again.'): ActionResult {
  if (isAppError(e) && e.expose) return { ok: false, error: e.message };
  return { ok: false, error: fallback };
}

/**
 * Proposes a WordPress content fix for one SEO crawl issue (Phase 9, §22 —
 * "WordPress becomes an execution layer for SEO"). Only ever files a
 * pending approval via the existing queue — nothing is written to
 * WordPress here.
 */
export async function proposeWordPressSeoFixAction(input: {
  siteId: string;
  issueId: string;
}): Promise<ActionResult> {
  try {
    const { user, org } = await requirePermission('content:manage');
    const rl = await security.checkRateLimit({
      key: `wp-seo-fix:${org.id}:${user.id}`,
      limit: 20,
      windowSec: 3600,
    });
    if (!rl.ok) return { ok: false, error: 'Too many attempts. Wait a few minutes and try again.' };

    const { proposal } = await wordpress.proposeContentFixForIssue({
      organizationId: org.id,
      userId: user.id,
      issueId: input.issueId,
      siteId: input.siteId,
    });
    revalidatePath('/app/wordpress/seo');
    revalidatePath('/app/integrations/approvals');
    return {
      ok: true,
      message: `Proposed a ${proposal.field} change for approval: "${proposal.proposedValue.slice(0, 80)}${proposal.proposedValue.length > 80 ? '…' : ''}"`,
    };
  } catch (e) {
    return toError(e);
  }
}

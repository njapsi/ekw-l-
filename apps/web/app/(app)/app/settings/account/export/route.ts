import { security, users } from '@growth-agent/services';
import { requireUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Personal data export (Phase 2, Part 30). Only the signed-in person's own
 * data — never another member's, never any organization's business data.
 */
export async function GET() {
  const user = await requireUser();
  const rl = await security.checkRateLimit({
    key: `user-export:${user.id}`,
    limit: 3,
    windowSec: 600,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'An export was requested recently. Please wait a few minutes.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }
  const data = await users.exportUserData(user.id);
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="growth-agent-my-data-${stamp}.json"`,
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
    },
  });
}

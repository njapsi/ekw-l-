import { agent } from '@growth-agent/services';
import { requireActiveOrg } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Title + message-content search across the current user's conversations. */
export async function GET(req: Request) {
  const { user, org } = await requireActiveOrg();
  const q = new URL(req.url).searchParams.get('q') ?? '';
  const results = await agent.searchConversations({
    organizationId: org.id,
    userId: user.id,
    query: q,
  });
  return Response.json(results);
}

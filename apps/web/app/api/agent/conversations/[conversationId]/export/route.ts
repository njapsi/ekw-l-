import { agent } from '@growth-agent/services';
import { requireActiveOrg } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Download a conversation as Markdown (default) or JSON. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const { conversationId } = await params;
  const { user, org } = await requireActiveOrg();
  const format = new URL(req.url).searchParams.get('format') === 'json' ? 'json' : 'markdown';

  try {
    const out = await agent.exportConversation({
      organizationId: org.id,
      userId: user.id,
      conversationId,
      format,
    });
    return new Response(out.content, {
      headers: {
        'content-type':
          format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${out.filename}"`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return Response.json({ error: 'Conversation not found.' }, { status: 404 });
  }
}

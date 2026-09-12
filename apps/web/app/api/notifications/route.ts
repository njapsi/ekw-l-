import { notifications, security } from '@growth-agent/services';
import { requireActiveOrg } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The current user's in-app notifications for the active org (theirs + org-wide).
 * `?unread=1` filters to unread; `?limit=` caps the page (max 100).
 */
export async function GET(req: Request) {
  const { user, org } = await requireActiveOrg();
  const url = new URL(req.url);
  const unreadOnly = url.searchParams.get('unread') === '1';
  const limit = Number(url.searchParams.get('limit') ?? '30');

  const [items, unread] = await Promise.all([
    notifications.listNotifications({
      organizationId: org.id,
      userId: user.id,
      unreadOnly,
      limit: Number.isFinite(limit) ? limit : 30,
    }),
    notifications.unreadCount(org.id, user.id),
  ]);

  return Response.json({ unread, items }, { headers: { 'cache-control': 'no-store' } });
}

/** Mark notifications read: `{ ids: string[] }` or `{ all: true }`. */
export async function POST(req: Request) {
  const { user, org } = await requireActiveOrg();

  const ip = security.clientIpFrom(req.headers);
  const rl = await security.checkRateLimit({
    key: `notif-read:${org.id}:${user.id}:${ip}`,
    limit: 120,
    windowSec: 60,
  });
  if (!rl.ok) {
    return Response.json(
      { error: 'Too many requests.' },
      { status: 429, headers: { 'retry-after': String(rl.retryAfterSec) } },
    );
  }

  let body: { ids?: unknown; all?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  const scope = { organizationId: org.id, userId: user.id };
  let updated = 0;
  if (body.all === true) {
    updated = await notifications.markAllRead(scope);
  } else if (Array.isArray(body.ids)) {
    updated = await notifications.markRead(
      body.ids.filter((v): v is string => typeof v === 'string'),
      scope,
    );
  } else {
    return Response.json({ error: 'Provide { ids: string[] } or { all: true }.' }, { status: 400 });
  }

  return Response.json({ updated });
}

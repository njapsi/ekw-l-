import type { Metadata } from 'next';
import { tiktok } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';
import { RefreshStatusButton } from '@/components/app/tiktok/tiktok-actions';
import { ApprovePublishButton, CreateDraftForm } from '@/components/app/tiktok/publish-form';
import { TikTokEmpty } from '@/components/app/tiktok/tiktok-empty';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';
import { loadTikTokState } from '@/lib/tiktok-state';

export const metadata: Metadata = { title: 'TikTok — Publishing' };

const statusVariant: Record<string, 'secondary' | 'warning' | 'destructive' | 'outline'> = {
  PUBLISHED: 'secondary',
  PROCESSING: 'warning',
  SUBMITTED: 'warning',
  AWAITING_APPROVAL: 'outline',
  DRAFT: 'outline',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

export default async function TikTokPublishingPage() {
  const { org } = await requireActiveOrg();
  const state = await loadTikTokState(org.id);
  if (state.kind !== 'ready') return <TikTokEmpty state={state} />;

  const publishes = await tiktok.listPublishes(org.id);
  const canPublish = state.connection.canPublish;

  return (
    <div className="space-y-6">
      <Alert>
        <AlertTitle>How publishing works</AlertTitle>
        <AlertDescription>
          Posts go through TikTok’s official Content Posting API. Nothing is ever submitted without
          your explicit approval on this page. Public posts require your TikTok app to be audited by
          TikTok; unaudited apps can only post privately.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New post</CardTitle>
          <CardDescription>
            Select a source video, write a caption, choose privacy, then create a draft.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateDraftForm canPublish={canPublish} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Publish history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {publishes.length === 0 ? (
            <p className="text-muted-foreground text-sm">No drafts or posts yet.</p>
          ) : (
            publishes.map((p) => (
              <div key={p.id} className="border-border rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={statusVariant[p.status] ?? 'outline'}>
                    {p.status.toLowerCase().replace(/_/g, ' ')}
                  </Badge>
                  <Badge variant="outline">{p.privacy.toLowerCase().replace(/_/g, ' ')}</Badge>
                  <span className="text-muted-foreground text-xs">
                    created {relDate(p.createdAt)}
                  </span>
                </div>
                <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-sm">{p.caption}</p>
                {p.hashtags.length ? (
                  <p className="text-muted-foreground mt-1 text-xs">
                    {p.hashtags.map((h) => `#${h}`).join(' ')}
                  </p>
                ) : null}
                {p.error ? <p className="text-destructive mt-1 text-xs">{p.error}</p> : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {p.status === 'AWAITING_APPROVAL' ? (
                    <ApprovePublishButton
                      publishId={p.id}
                      caption={p.caption}
                      privacy={p.privacy}
                    />
                  ) : null}
                  {['SUBMITTED', 'PROCESSING'].includes(p.status) ? (
                    <RefreshStatusButton publishRowId={p.id} />
                  ) : null}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

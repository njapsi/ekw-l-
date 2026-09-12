import type { Metadata } from 'next';
import Link from 'next/link';
import { content, youtube } from '@growth-agent/services';
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { NewProjectForm } from '@/components/app/content/new-project-form';
import { requireActiveOrg } from '@/lib/auth';
import { relDate } from '@/lib/format';

export const metadata: Metadata = { title: 'Content repurposing' };

export default async function ContentPage() {
  const { org } = await requireActiveOrg();
  const [projects, videosPage] = await Promise.all([
    content.listProjects(org.id),
    youtube.listVideosPage(org.id, { limit: 40, sort: 'recent' }).catch(() => ({ videos: [] })),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Content repurposing"
        description="Turn one piece of source content into titles, descriptions, chapters, shorts / TikTok ideas, hooks, scripts, social posts, blog outlines, FAQs and newsletter angles. Pipeline: source → analysis → key ideas → angles → platform content → approve → publish/schedule. The engine never publishes for you."
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">New repurposing project</CardTitle>
          <CardDescription>
            Start from a synced YouTube video, a video URL (paste the transcript — the engine does
            not fetch or transcribe), a pasted transcript, or any text you provide.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NewProjectForm videos={videosPage.videos.map((v) => ({ id: v.id, title: v.title }))} />
        </CardContent>
      </Card>

      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet."
          description="Create one above to generate a full content set."
        />
      ) : (
        <div className="grid gap-3">
          {projects.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <Link href={`/app/content/${p.id}`} className="hover:underline">
                      {p.name}
                    </Link>
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline">{p.sourceType.toLowerCase().replace('_', ' ')}</Badge>
                    <Badge variant={p.status === 'READY' ? 'secondary' : 'outline'}>
                      {p.status.toLowerCase()}
                    </Badge>
                  </div>
                </div>
                <CardDescription>
                  {p.sourceTitle ?? 'No source title'} · {p.assetCount} asset(s) · updated{' '}
                  {relDate(p.updatedAt)}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

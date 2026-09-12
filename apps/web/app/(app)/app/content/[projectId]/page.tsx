import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { content } from '@growth-agent/services';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  PageHeader,
} from '@growth-agent/ui';
import { AssetCard, type AssetView } from '@/components/app/content/asset-card';
import { AnalyzeButton, GenerateButton } from '@/components/app/content/project-actions';
import { requireActiveOrg } from '@/lib/auth';

export const metadata: Metadata = { title: 'Repurposing project' };

const PIPELINE = [
  'SOURCE CONTENT',
  'CONTENT ANALYSIS',
  'KEY IDEAS',
  'CONTENT ANGLES',
  'PLATFORM-SPECIFIC CONTENT',
  'APPROVAL',
  'PUBLISH / SCHEDULE',
];

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const { org } = await requireActiveOrg();
  const project = await content.getProject(org.id, projectId);
  if (!project) notFound();

  const analysis = project.analysis;
  const assetsByType = new Map<string, AssetView[]>();
  for (const a of project.assets) {
    const list = assetsByType.get(a.type) ?? [];
    list.push({
      ...a,
      scheduledFor: a.scheduledFor ? a.scheduledFor.toISOString() : null,
      publishedAt: a.publishedAt ? a.publishedAt.toISOString() : null,
    });
    assetsByType.set(a.type, list);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={project.name}
        description={project.sourceTitle ?? undefined}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href="/app/content">All projects</Link>
          </Button>
        }
      />

      <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-xs">
        {PIPELINE.map((step, i) => (
          <span key={step} className="flex items-center gap-1">
            <span
              className={
                (i <= 3 && analysis) || (i <= 4 && project.assets.length) || i === 0
                  ? 'text-foreground'
                  : ''
              }
            >
              {step}
            </span>
            {i < PIPELINE.length - 1 ? <span>↓</span> : null}
          </span>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Source</CardTitle>
          <CardDescription>{project.sourceType.toLowerCase().replace('_', ' ')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {project.sourceUrl ? (
            <p className="truncate font-mono text-xs">{project.sourceUrl}</p>
          ) : null}
          {project.sourceTags.length ? (
            <p className="text-muted-foreground text-xs">
              Tags: {project.sourceTags.slice(0, 12).join(', ')}
            </p>
          ) : null}
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">Source text</summary>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap">
              {[project.sourceDescription, project.sourceTranscript, project.sourceBody]
                .filter(Boolean)
                .join('\n\n---\n\n') || '(none)'}
            </pre>
          </details>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">2–4. Analysis · key ideas · angles</CardTitle>
            <AnalyzeButton projectId={project.id} />
          </div>
          {!project.analysisGrounded && analysis ? (
            <CardDescription className="text-destructive">
              The AI analysis could not be fully grounded in the source and was replaced with a
              mechanical summary.
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!analysis ? (
            <p className="text-muted-foreground">Not analyzed yet.</p>
          ) : (
            <>
              <p>{analysis.summary}</p>
              <div>
                <p className="text-xs font-semibold uppercase">Key ideas</p>
                <ul className="mt-1 list-disc pl-5">
                  {analysis.keyIdeas.map((k) => (
                    <li key={k.id}>
                      {k.idea}
                      {k.sourceQuote ? (
                        <span className="text-muted-foreground"> — “{k.sourceQuote}”</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase">Content angles</p>
                <ul className="mt-1 list-disc pl-5">
                  {analysis.contentAngles.map((a) => (
                    <li key={a.id}>
                      <span className="font-medium">{a.angle}</span> — {a.rationale}
                    </li>
                  ))}
                </ul>
              </div>
              {analysis.keywords.length ? (
                <p className="text-muted-foreground text-xs">
                  Keywords: {analysis.keywords.join(', ')}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">5. Platform-specific content</CardTitle>
            <GenerateButton projectId={project.id} />
          </div>
          <CardDescription>
            13 deliverable types. Every piece is a draft you can edit; versions are kept. Statuses:
            draft → approved → scheduled/published, or failed.
            {project.statusCounts && Object.keys(project.statusCounts).length ? (
              <>
                {' '}
                Counts:{' '}
                {Object.entries(project.statusCounts)
                  .map(([s, n]) => `${n} ${s.toLowerCase()}`)
                  .join(', ')}
                .
              </>
            ) : null}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {project.assets.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing generated yet.</p>
          ) : (
            [...assetsByType.entries()].map(([type, assets]) => (
              <div key={type} className="space-y-2">
                <div className="grid gap-2">
                  {assets.map((a) => (
                    <AssetCard key={a.id} asset={a} projectId={project.id} />
                  ))}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertTitle>Publishing</AlertTitle>
        <AlertDescription>
          The engine never publishes. Approve a piece, optionally set a schedule date, then post it
          yourself and click <em>Mark published</em>. For TikTok, the gated Publishing flow lives at{' '}
          <span className="font-mono text-xs">/app/tiktok/publishing</span>. Every status change is
          written to the audit log.
        </AlertDescription>
      </Alert>
    </div>
  );
}

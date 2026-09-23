import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Badge, Card, CardContent, CardHeader, CardTitle, PageHeader } from '@growth-agent/ui';
import { isAppError, research } from '@growth-agent/services';
import { requireActiveOrg } from '@/lib/auth';
import { CancelResearchButton } from '@/components/app/research/cancel-research-button';

export const metadata: Metadata = { title: 'Research Project' };

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  REQUESTED: 'outline',
  PLANNING: 'secondary',
  SEARCHING: 'secondary',
  COLLECTING: 'secondary',
  ANALYZING: 'secondary',
  VERIFYING: 'secondary',
  COMPLETED: 'success',
  PARTIALLY_COMPLETED: 'warning',
  FAILED: 'destructive',
  CANCELLED: 'outline',
};

const STAGES = ['REQUESTED', 'PLANNING', 'SEARCHING', 'COLLECTING', 'ANALYZING', 'VERIFYING', 'COMPLETED'];

interface PageProps {
  params: Promise<{ researchId: string }>;
}

export default async function ResearchDetailPage({ params }: PageProps) {
  const { researchId } = await params;
  const { org } = await requireActiveOrg();

  let project: Awaited<ReturnType<typeof research.getResearchProject>>;
  try {
    project = await research.getResearchProject(org.id, researchId);
  } catch (e) {
    if (isAppError(e) && e.code === 'resource_not_found') notFound();
    throw e;
  }

  const inProgress = !['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'].includes(project.status);
  const currentStageIndex = STAGES.indexOf(project.status);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Research"
        description={project.question}
        actions={inProgress ? <CancelResearchButton researchId={project.id} /> : undefined}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={STATUS_VARIANT[project.status] ?? 'outline'}>
          {project.status.replace(/_/g, ' ').toLowerCase()}
        </Badge>
        {project.confidence != null ? (
          <Badge variant="outline">{Math.round(project.confidence * 100)}% confidence</Badge>
        ) : null}
      </div>

      {inProgress ? (
        <Card>
          <CardContent className="pt-6">
            <ol className="flex flex-wrap gap-2 text-xs">
              {STAGES.map((stage, i) => (
                <li
                  key={stage}
                  className={`rounded-full border px-2.5 py-1 ${
                    i <= currentStageIndex
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {stage.toLowerCase()}
                </li>
              ))}
            </ol>
            <p className="text-muted-foreground mt-3 text-sm">
              Running in the background — refresh this page to see progress.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {project.failureReason ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Why this didn&apos;t complete</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{project.failureReason}</CardContent>
        </Card>
      ) : null}

      {project.conclusion ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conclusion</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{project.conclusion}</CardContent>
        </Card>
      ) : null}

      {project.findings.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Findings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {project.findings.map((f) => (
              <div key={f.id} className="border-border border-l-2 pl-3">
                <p>{f.finding}</p>
                <p className="text-muted-foreground text-xs">
                  Confidence {Math.round(f.confidence * 100)}%
                  {f.source?.url ? (
                    <>
                      {' · '}
                      <a href={f.source.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                        {f.source.url}
                      </a>
                    </>
                  ) : null}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {project.citations.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {project.citations.map((c) => (
              <p key={c.id}>
                <a href={c.url} target="_blank" rel="noreferrer noopener" className="underline underline-offset-2">
                  {c.source.title ?? c.url}
                </a>
                <span className="text-muted-foreground text-xs">
                  {' '}
                  — retrieved {c.retrievedAt.toLocaleString()}
                </span>
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

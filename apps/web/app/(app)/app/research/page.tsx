import type { Metadata } from 'next';
import Link from 'next/link';
import { FlaskConical } from 'lucide-react';
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
import { requireActiveOrg } from '@/lib/auth';
import { research } from '@growth-agent/services';
import { ResearchForm } from '@/components/app/research/research-form';

export const metadata: Metadata = { title: 'Research' };

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

export default async function ResearchListPage() {
  const { org } = await requireActiveOrg();
  const projects = await research.listResearchProjects(org.id, { limit: 50 });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Research"
        description="Tracked research projects — evidence gathered, cited, and synthesized. Every finding traces back to a real, fetched source."
      />

      <ResearchForm />

      {projects.length === 0 ? (
        <EmptyState
          icon={<FlaskConical />}
          title="No research yet"
          description="Start a research project above."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/app/research/${p.id}`} className="block">
              <Card className="hover:border-primary/50 h-full transition-colors">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">Research</CardTitle>
                    <Badge variant={STATUS_VARIANT[p.status] ?? 'outline'}>
                      {p.status.replace(/_/g, ' ').toLowerCase()}
                    </Badge>
                  </div>
                  <CardDescription className="line-clamp-2">{p.question}</CardDescription>
                </CardHeader>
                <CardContent className="text-muted-foreground text-xs">
                  {p.createdAt.toLocaleDateString()}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

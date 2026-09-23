import type { Metadata } from 'next';
import Link from 'next/link';
import { AlertTriangle, BookOpen, FlaskConical, Inbox, Plus } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  PageHeader,
} from '@growth-agent/ui';
import { requireActiveOrg } from '@/lib/auth';
import { knowledge } from '@growth-agent/services';

export const metadata: Metadata = { title: 'Knowledge Center' };

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'outline' | 'secondary' | 'destructive'> = {
  DRAFT: 'outline',
  ACTIVE: 'success',
  VERIFIED: 'success',
  UNVERIFIED: 'secondary',
  STALE: 'warning',
  CONFLICTED: 'destructive',
  ARCHIVED: 'outline',
  EXPIRED: 'outline',
  REJECTED: 'outline',
};

const CLASSIFICATION_LABEL: Record<string, string> = {
  FACT: 'Fact',
  INFERENCE: 'Inference',
  HYPOTHESIS: 'Hypothesis',
  OPINION: 'Opinion',
  USER_PROVIDED: 'You told us',
  SYSTEM_OBSERVED: 'Observed',
  EXTERNAL_SOURCE: 'External source',
};

interface PageProps {
  searchParams: Promise<{ type?: string; status?: string; q?: string }>;
}

export default async function KnowledgeCenterPage({ searchParams }: PageProps) {
  const { org } = await requireActiveOrg();
  const params = await searchParams;

  const [{ items }, conflicts, pendingMemories] = await Promise.all([
    knowledge.listKnowledgeItems(org.id, {
      type: params.type,
      status: params.status,
      search: params.q,
      limit: 50,
    }),
    knowledge.listConflicts(org.id, 'OPEN'),
    knowledge.listMemoryCandidates(org.id, 'PENDING'),
  ]);

  const staleCount = items.filter((i) => i.status === 'STALE').length;
  const verifiedCount = items.filter((i) => i.status === 'VERIFIED').length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Knowledge Center"
        description="What Growth Agent knows about your business, market, and past results — with sources, confidence, and freshness, never invented."
        actions={
          <Button asChild>
            <Link href="/app/knowledge/new">
              <Plus className="size-4" /> Add knowledge
            </Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total knowledge</CardDescription>
            <CardTitle className="text-2xl">{items.length}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">{verifiedCount} verified</CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Stale</CardDescription>
            <CardTitle className="text-2xl">{staleCount}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">Past their freshness window</CardContent>
        </Card>
        <Link href="/app/knowledge/conflicts">
          <Card className="hover:border-primary/50 h-full transition-colors">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <AlertTriangle className="size-3.5" /> Conflicts
              </CardDescription>
              <CardTitle className="text-2xl">{conflicts.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">Awaiting resolution</CardContent>
          </Card>
        </Link>
        <Link href="/app/knowledge/memories">
          <Card className="hover:border-primary/50 h-full transition-colors">
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-1">
                <Inbox className="size-3.5" /> To review
              </CardDescription>
              <CardTitle className="text-2xl">{pendingMemories.length}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">Memory candidates</CardContent>
          </Card>
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" asChild>
          <Link href="/app/research">
            <FlaskConical className="size-4" /> Research projects
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href="/app/knowledge/memories">
            <Inbox className="size-4" /> Review memory ({pendingMemories.length})
          </Link>
        </Button>
        <Button variant="outline" size="sm" asChild>
          <Link href="/app/knowledge/conflicts">
            <AlertTriangle className="size-4" /> Resolve conflicts ({conflicts.length})
          </Link>
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<BookOpen />}
          title="No knowledge stored yet"
          description="Add your business profile, brand guidelines, or research — or just chat with the AI Agent and it will start remembering durable facts about your business, with your review."
          action={
            <Button asChild>
              <Link href="/app/knowledge/new">Add knowledge</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Link key={item.id} href={`/app/knowledge/${item.id}`} className="block">
              <Card className="hover:border-primary/50 h-full transition-colors">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">{item.title}</CardTitle>
                    <Badge variant={STATUS_VARIANT[item.status] ?? 'outline'}>
                      {item.status.toLowerCase()}
                    </Badge>
                  </div>
                  <CardDescription className="line-clamp-2">
                    {item.summary ?? item.content}
                  </CardDescription>
                </CardHeader>
                <CardContent className="text-muted-foreground flex items-center justify-between text-xs">
                  <span>
                    {item.type.replace(/_/g, ' ').toLowerCase()} ·{' '}
                    {CLASSIFICATION_LABEL[item.classification] ?? item.classification}
                  </span>
                  <span>{Math.round(item.confidence * 100)}% confidence</span>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

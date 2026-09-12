import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Plug } from 'lucide-react';
import {
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

export const metadata: Metadata = { title: 'Dashboard' };

const stats = [
  { label: 'Connected accounts', hint: 'Connect YouTube, TikTok, or Search Console' },
  { label: 'SEO projects', hint: 'Add a website to run your first audit' },
  { label: 'Open recommendations', hint: 'Recommendations appear after your first analysis' },
];

export default async function DashboardPage() {
  const { org } = await requireActiveOrg();

  return (
    <div className="space-y-6">
      <PageHeader
        title={`${org.name}`}
        description="Your growth overview. Connect a source to start seeing analysis here."
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardDescription>{s.label}</CardDescription>
              <CardTitle className="text-2xl">—</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-xs">{s.hint}</CardContent>
          </Card>
        ))}
      </div>

      <EmptyState
        icon={<Plug />}
        title="Nothing to analyze yet"
        description="Connect YouTube, TikTok, or Google Search Console, or add a website for a technical SEO audit. We never show sample or fabricated data."
        action={
          <Button asChild>
            <Link href="/app/integrations">
              Go to integrations <ArrowRight className="size-4" />
            </Link>
          </Button>
        }
      />
    </div>
  );
}

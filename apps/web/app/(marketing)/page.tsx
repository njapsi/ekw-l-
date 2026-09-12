import Link from 'next/link';
import { BarChart3, Bot, Gauge, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@growth-agent/ui';

const capabilities = [
  {
    icon: <BarChart3 />,
    title: 'YouTube & TikTok analysis',
    body: 'Connect your accounts. We analyze performance, titles, topics, and cadence — and never invent numbers an API did not return.',
  },
  {
    icon: <Gauge />,
    title: 'Technical SEO',
    body: 'A bounded, robots-aware crawler checks status codes, canonicals, sitemaps, structured data, rendering, and crawl depth.',
  },
  {
    icon: <Bot />,
    title: 'An AI growth agent',
    body: 'Specialized agents reason over your data and produce prioritized actions with evidence, effort, and a confidence level.',
  },
  {
    icon: <ShieldCheck />,
    title: 'Explainable, never guaranteed',
    body: 'Every recommendation shows its evidence. We never promise monetization approval, revenue, or search rankings.',
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col">
      <section className="container flex flex-col gap-6 py-20 sm:py-28">
        <p className="text-muted-foreground text-sm font-medium uppercase tracking-widest">
          Growth Agent
        </p>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Turn your analytics and site data into prioritized, explainable growth actions.
        </h1>
        <p className="text-muted-foreground max-w-2xl text-lg">
          For YouTube and TikTok creators, website owners, and SEO teams. Connect your accounts and
          sites; get a ranked list of what to do next — with the evidence behind it.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/signup">Get started</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <Link href="/docs">Read the docs</Link>
          </Button>
        </div>
      </section>

      <section className="container grid gap-6 pb-24 sm:grid-cols-2">
        {capabilities.map((c) => (
          <Card key={c.title}>
            <CardHeader className="flex-row items-center gap-3 space-y-0">
              <span className="bg-accent text-accent-foreground flex size-9 items-center justify-center rounded-md [&_svg]:size-4">
                {c.icon}
              </span>
              <CardTitle className="text-base">{c.title}</CardTitle>
            </CardHeader>
            <CardContent className="text-muted-foreground text-sm">{c.body}</CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}

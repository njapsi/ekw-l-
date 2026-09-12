import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Features' };

const groups = [
  {
    heading: 'AI growth agent',
    items: [
      'Specialized agents (YouTube, TikTok, SEO auditor, content, monetization, reporting) behind an orchestrator',
      'Every statement tagged as fact, calculated metric, assumption, prediction, or recommendation',
      'Structured, explainable recommendations with evidence, expected impact, effort, and confidence',
      'Token and cost tracking per organization',
    ],
  },
  {
    heading: 'YouTube & TikTok',
    items: [
      'Connect accounts through official APIs',
      'Channel, video, title, description, topic, and publishing-pattern analysis',
      'Monetization-readiness assessment (an estimate — never a guarantee)',
      'Content-opportunity gaps and idea generation',
    ],
  },
  {
    heading: 'Technical SEO',
    items: [
      'Bounded, robots-aware, SSRF-safe crawler',
      'Status codes, redirects, canonicals, sitemaps, indexability, internal linking',
      'Structured data, metadata, rendering (SSR/CSR/JS), Core Web Vitals where measurable',
      'Ranked issues with plain-language fixes and affected URLs',
    ],
  },
  {
    heading: 'Built for teams',
    items: [
      'Multi-tenant organizations with strict isolation',
      'Roles: owner, admin, member, viewer',
      'Audit log of security-relevant actions',
      'Human approval for anything that changes an external system',
    ],
  },
];

export default function FeaturesPage() {
  return (
    <div className="container flex flex-col gap-10 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Features</h1>
        <p className="text-muted-foreground max-w-2xl">
          What Growth Agent does today, and the guardrails it holds to.
        </p>
      </header>
      <div className="grid gap-8 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g.heading} className="space-y-3">
            <h2 className="text-lg font-medium">{g.heading}</h2>
            <ul className="text-muted-foreground space-y-2 text-sm">
              {g.items.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden className="bg-primary mt-2 size-1.5 shrink-0 rounded-full" />
                  {item}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

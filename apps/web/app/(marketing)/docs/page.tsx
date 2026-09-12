import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Documentation' };

const sections = [
  {
    heading: 'Getting started',
    body: 'Create an organization, invite your team, and connect your first account or website. Growth Agent creates a personal workspace for you automatically on sign-up.',
  },
  {
    heading: 'How recommendations work',
    body: 'Each recommendation carries its evidence, an expected impact, an effort estimate, and a confidence level. Statements are labelled as fact, calculated metric, assumption, prediction, or recommendation. If an API did not return something, we say so rather than guess.',
  },
  {
    heading: 'Integrations',
    body: 'YouTube and Google Search Console connect via OAuth with read-only scopes. TikTok uses the official API. Tokens are encrypted at rest and never sent to your browser.',
  },
  {
    heading: 'The SEO crawler',
    body: 'The crawler is bounded and robots-aware. It only crawls sites you have verified you control, resolves DNS itself, blocks private and internal addresses, and never acts as an open fetch proxy.',
  },
  {
    heading: 'Approvals & automation',
    body: 'Anything that changes an external system — publishing, metadata edits, deletions — needs your explicit approval unless you deliberately enable automation mode for that scope.',
  },
];

export default function DocsPage() {
  return (
    <div className="container flex max-w-3xl flex-col gap-8 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Documentation</h1>
        <p className="text-muted-foreground">
          A short overview while the full docs site is under construction.
        </p>
      </header>
      {sections.map((s) => (
        <section key={s.heading} className="space-y-2">
          <h2 className="text-lg font-medium">{s.heading}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">{s.body}</p>
        </section>
      ))}
    </div>
  );
}

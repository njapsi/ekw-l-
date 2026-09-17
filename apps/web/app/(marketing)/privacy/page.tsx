import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <div className="container max-w-3xl space-y-8 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="text-muted-foreground text-sm">Last updated: {new Date().toISOString().slice(0, 10)}</p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">What Growth Agent is</h2>
        <p className="text-muted-foreground">
          Growth Agent is a multi-tenant application for YouTube and TikTok creators, website owners,
          and SEO professionals. It connects to your accounts and websites, analyzes the data those
          services return, and produces prioritized, explainable recommendations. It never fabricates
          data — if a connected API doesn&apos;t return a figure, we say so rather than inventing one.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">What we collect</h2>
        <ul className="text-muted-foreground list-disc space-y-1.5 pl-5">
          <li>Account information you provide (name, email) and organization membership.</li>
          <li>
            OAuth tokens for services you explicitly connect (YouTube, TikTok, Google Search Console),
            scoped to only the permissions each integration requests.
          </li>
          <li>
            Analytics and content data returned by those connected services (e.g. video metrics, channel
            performance, search performance), and data from websites you add and verify ownership of.
          </li>
          <li>Content you provide directly, such as text used for AI-assisted content generation.</li>
          <li>Standard operational logs (requests, errors) used to run and secure the service.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">How we use it</h2>
        <p className="text-muted-foreground">
          Connected-account and website data is used only to generate the analysis, recommendations, and
          reports you request inside your organization. Content you submit for AI features is sent to the
          configured AI provider solely to produce that response — it is not used to train models we
          control. We never sell your data.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">How it&apos;s protected</h2>
        <p className="text-muted-foreground">
          OAuth tokens are encrypted at rest (AES-256-GCM) and never sent to your browser. Every piece of
          data is scoped to your organization and is not visible to other tenants. Access follows
          role-based permissions within your organization, and actions that publish content or change
          external settings require your explicit approval before they happen.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Your controls</h2>
        <p className="text-muted-foreground">
          You can disconnect any connected account at any time from Integrations, which revokes our
          access and deletes the stored tokens. You can export your organization&apos;s data or request
          deletion of your account from Settings.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Third-party services</h2>
        <p className="text-muted-foreground">
          We integrate with YouTube (Google), TikTok, Google Search Console, and a payment processor for
          billing. Each is governed by its own privacy policy in addition to this one, and we only
          request the scopes each feature actually needs.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p className="text-muted-foreground">
          Questions about this policy or your data can be sent to the contact address listed on our
          Docs page.
        </p>
      </section>
    </div>
  );
}

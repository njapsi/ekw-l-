import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Terms of Service' };

export default function TermsPage() {
  return (
    <div className="container max-w-3xl space-y-8 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Terms of Service</h1>
        <p className="text-muted-foreground text-sm">
          Last updated: {new Date().toISOString().slice(0, 10)}
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">The service</h2>
        <p className="text-muted-foreground">
          Growth Agent connects to accounts and websites you own or are authorized to manage —
          YouTube, TikTok, Google Search Console, and websites you verify ownership of — and
          produces analysis, recommendations, and generated content based on the data those sources
          return.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">No guarantees</h2>
        <p className="text-muted-foreground">
          Growth Agent never guarantees monetization approval, revenue, or search or AI-assistant
          rankings. Recommendations are explainable and grounded in the data available at the time
          they were generated, but outcomes on YouTube, TikTok, Google, or any other third-party
          platform are determined solely by that platform.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Your responsibilities</h2>
        <ul className="text-muted-foreground list-disc space-y-1.5 pl-5">
          <li>You must own or be authorized to manage any account or website you connect.</li>
          <li>
            Actions that publish content or change external settings require your explicit approval
            before they happen — the service will not take those actions on its own.
          </li>
          <li>You are responsible for complying with the terms of each platform you connect.</li>
          <li>
            You must not use the service to crawl or access websites you don&apos;t own or control.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Billing</h2>
        <p className="text-muted-foreground">
          Paid plans are billed through our payment processor on the cycle you select at checkout.
          Usage limits for each plan are shown on the Pricing page and enforced automatically;
          exceeding a limit may require an upgrade to continue that specific action.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Account termination</h2>
        <p className="text-muted-foreground">
          You may delete your account or organization at any time from Settings. We may suspend
          access for activity that violates these terms, including unauthorized crawling or attempts
          to bypass usage limits.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Changes</h2>
        <p className="text-muted-foreground">
          We may update these terms as the service evolves. Material changes will be reflected by
          updating the date at the top of this page.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Contact</h2>
        <p className="text-muted-foreground">
          Questions about these terms can be sent to the contact address listed on our Docs page.
        </p>
      </section>
    </div>
  );
}

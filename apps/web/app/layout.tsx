import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
// Side effect: validate the environment at server boot. A misconfigured
// production deploy fails here with a readable field list instead of at the
// first request (FORENSIC-AUDIT D-3 / M-10).
import '@growth-agent/services/config';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'),
  title: {
    default: 'Growth Agent — AI creator & SEO growth',
    template: '%s · Growth Agent',
  },
  description:
    'An AI growth agent for YouTube and TikTok creators, website owners, and SEO professionals. Prioritized, explainable recommendations from your own data.',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b1120' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

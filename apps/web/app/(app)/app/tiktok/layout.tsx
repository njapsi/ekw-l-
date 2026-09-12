import type { ReactNode } from 'react';
import { PageHeader } from '@growth-agent/ui';
import { TikTokTabs } from '@/components/app/tiktok/tiktok-tabs';

export default function TikTokLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <PageHeader
        title="TikTok"
        description="Profile and video analysis, the TikTok Analyst Agent, and authorized publishing. Official API only — no scraping."
      />
      <TikTokTabs />
      <div className="pt-1">{children}</div>
    </div>
  );
}

import type { ReactNode } from 'react';
import { PageHeader } from '@growth-agent/ui';
import { YouTubeTabs } from '@/components/app/youtube/youtube-tabs';

export default function YouTubeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <PageHeader
        title="YouTube"
        description="Channel analysis, performance, growth, and the YouTube Analyst Agent. Read-only, official APIs only."
      />
      <YouTubeTabs />
      <div className="pt-1">{children}</div>
    </div>
  );
}

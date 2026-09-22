import type { ReactNode } from 'react';
import { PageHeader } from '@growth-agent/ui';
import { WordPressTabs } from '@/components/app/wordpress/wordpress-tabs';

export default function WordPressLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5">
      <PageHeader
        title="WordPress"
        description="What your connected site's capabilities allow, which pages are worth refreshing, and how SEO findings become approval-gated WordPress fixes."
      />
      <WordPressTabs />
      <div className="pt-1">{children}</div>
    </div>
  );
}

import type { ReactNode } from 'react';
import { EmptyState, PageHeader } from '@growth-agent/ui';

export function FeaturePlaceholder({
  title,
  description,
  icon,
  emptyTitle,
  emptyDescription,
  action,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} />
      <EmptyState icon={icon} title={emptyTitle} description={emptyDescription} action={action} />
    </div>
  );
}

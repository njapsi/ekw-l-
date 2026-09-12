import { Skeleton } from '@growth-agent/ui';

export default function AppLoading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading page content">
      <Skeleton className="h-9 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
        <Skeleton className="h-28" />
      </div>
      <Skeleton className="h-56" />
    </div>
  );
}

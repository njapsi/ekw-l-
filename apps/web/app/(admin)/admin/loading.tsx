import { Skeleton } from '@growth-agent/ui';

/**
 * Some admin pages run aggregate queries (`pg_stat_*`, cross-tenant rollups),
 * so give the section a skeleton instead of a blank frame while they resolve.
 */
export default function AdminLoading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading page content">
      <Skeleton className="h-8 w-64" />
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>
      <Skeleton className="h-64" />
    </div>
  );
}

import * as React from 'react';
import { cn } from '../lib/cn.js';

/**
 * A single decorative placeholder "bone" — `aria-hidden` by default since a
 * loading view typically renders several of these at once, and each
 * announcing itself would repeat "Loading" once per bone. Wrap the group in
 * one `role="status"` container instead (see `apps/web/app/(app)/app/
 * loading.tsx` for the pattern) so screen readers hear it once.
 */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn('bg-muted animate-pulse rounded-md', className)}
      {...props}
    />
  );
}

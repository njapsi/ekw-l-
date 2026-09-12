import * as React from 'react';
import { cn } from '../lib/cn.js';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** A lucide icon element, e.g. `<Youtube />`. */
  icon?: React.ReactNode;
  title: string;
  description?: string;
  /** Primary call to action. */
  action?: React.ReactNode;
}

/**
 * Standard empty state. Used across the app instead of fabricated data — e.g.
 * "Connect YouTube to begin analyzing your channel."
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'border-border bg-card/50 flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-14 text-center',
        className,
      )}
      {...props}
    >
      {icon ? (
        <div className="bg-muted text-muted-foreground mb-4 flex size-11 items-center justify-center rounded-full [&_svg]:size-5">
          {icon}
        </div>
      ) : null}
      <h3 className="text-foreground text-sm font-medium">{title}</h3>
      {description ? (
        <p className="text-muted-foreground mt-1.5 max-w-sm text-sm">{description}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

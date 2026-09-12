import { Loader2 } from 'lucide-react';
import { cn } from '../lib/cn.js';

export function Spinner({ className, label = 'Loading' }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-2">
      <Loader2 className={cn('text-muted-foreground size-4 animate-spin', className)} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

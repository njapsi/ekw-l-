'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@growth-agent/ui';
import { reportClientError } from '@/components/providers';

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
    reportClientError({
      message: error.message,
      stack: error.stack,
      name: error.name,
      source: 'error-boundary',
    });
  }, [error]);

  return (
    <div className="container flex min-h-[70vh] flex-col items-center justify-center gap-4 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground max-w-sm text-sm">
        An unexpected error occurred. You can retry, or head back home.
        {error.digest ? (
          <>
            {' '}
            Reference: <code className="font-mono text-xs">{error.digest}</code>
          </>
        ) : null}
      </p>
      <div className="flex gap-2">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/">Home</Link>
        </Button>
      </div>
    </div>
  );
}

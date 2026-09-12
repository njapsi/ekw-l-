'use client';

import { useEffect } from 'react';
import { Alert, AlertDescription, AlertTitle, Button } from '@growth-agent/ui';
import { reportClientError } from '@/components/providers';

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-side surface; the server already logged this with a request id.
    console.error(error);
    reportClientError({
      message: error.message,
      stack: error.stack,
      name: error.name,
      source: 'error-boundary',
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-md space-y-4 py-10">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>
          This section failed to load. You can try again — if it keeps happening, the reference is{' '}
          <code className="font-mono text-xs">{error.digest ?? 'n/a'}</code>.
        </AlertDescription>
      </Alert>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}

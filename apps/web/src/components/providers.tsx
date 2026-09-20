'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import { ThemeProvider, TooltipProvider, Toaster } from '@growth-agent/ui';

/** Best-effort client + edge error reporting (FORENSIC-AUDIT M-4). */
export function reportClientError(input: {
  message: string;
  stack?: string;
  name?: string;
  source?: string;
}): void {
  try {
    const body = JSON.stringify({ ...input, url: window.location?.pathname });
    // `keepalive` so it still flushes during an unload.
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}

function useGlobalErrorReporting() {
  useEffect(() => {
    let last = 0;
    const throttled = (fn: () => void) => {
      const now = Date.now();
      if (now - last < 5_000) return;
      last = now;
      fn();
    };
    const onError = (e: ErrorEvent) =>
      throttled(() =>
        reportClientError({
          message: e.message || 'window.onerror',
          stack: e.error instanceof Error ? e.error.stack : undefined,
          name: e.error instanceof Error ? e.error.name : 'Error',
          source: 'window.onerror',
        }),
      );
    const onRejection = (e: PromiseRejectionEvent) =>
      throttled(() =>
        reportClientError({
          message:
            e.reason instanceof Error ? e.reason.message : String(e.reason ?? 'unhandledrejection'),
          stack: e.reason instanceof Error ? e.reason.stack : undefined,
          name: e.reason instanceof Error ? e.reason.name : 'UnhandledRejection',
          source: 'unhandledrejection',
        }),
      );
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
      }),
  );
  useGlobalErrorReporting();

  return (
    <ThemeProvider>
      <SessionProvider>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={300}>
            {children}
            <Toaster />
          </TooltipProvider>
        </QueryClientProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

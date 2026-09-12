'use client';

import { useEffect } from 'react';
import { reportClientError } from '@/components/providers';

export default function GlobalError({
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
      source: 'global-error',
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: 'flex',
          minHeight: '100vh',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'system-ui, sans-serif',
          margin: 0,
        }}
      >
        <div style={{ textAlign: 'center', maxWidth: 420, padding: 24 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>The application crashed</h1>
          <p style={{ color: '#64748b', fontSize: 14 }}>
            A fatal error occurred{error.digest ? ` (ref ${error.digest})` : ''}. Please reload.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: 12,
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid #cbd5e1',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}

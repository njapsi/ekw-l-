'use client';

import { useState } from 'react';
import { Alert, AlertDescription, Button } from '@growth-agent/ui';

export function CheckEmailNotice({
  email,
  onResend,
}: {
  email: string;
  onResend: () => Promise<void>;
}) {
  const [resending, setResending] = useState(false);
  const [resent, setResent] = useState(false);

  return (
    <div className="space-y-4">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Check your email</h1>
        <p className="text-muted-foreground text-sm">
          We&apos;ve sent a link to <span className="text-foreground font-medium">{email}</span>.
          Click it to continue.
        </p>
      </div>
      {resent ? (
        <Alert>
          <AlertDescription>Sent again — check your inbox.</AlertDescription>
        </Alert>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={resending}
        onClick={async () => {
          setResending(true);
          await onResend();
          setResending(false);
          setResent(true);
        }}
      >
        {resending ? 'Sending…' : 'Resend link'}
      </Button>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Button, Input, Label } from '@growth-agent/ui';
import { requestPasswordResetAction } from '@/server/auth-actions';
import { CheckEmailNotice } from './check-email-notice';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent' | 'error'>('idle');

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setStatus('error');
      return;
    }
    setStatus('submitting');
    await requestPasswordResetAction(email);
    setStatus('sent');
  }

  if (status === 'sent') {
    return <CheckEmailNotice email={email} onResend={() => submit()} />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Reset your password</h1>
        <p className="text-muted-foreground text-sm">
          Enter your email and we&apos;ll send you a link to set a new password.
        </p>
      </div>
      <form onSubmit={submit} className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        {status === 'error' ? (
          <p role="alert" className="text-destructive text-sm">
            Enter a valid email address.
          </p>
        ) : null}
        <Button type="submit" className="w-full" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Sending…' : 'Send Reset Link'}
        </Button>
      </form>
    </div>
  );
}

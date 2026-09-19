'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, Button } from '@growth-agent/ui';
import { setPasswordAction, type SetPasswordResult } from '@/server/auth-actions';
import { PasswordInput } from '@/components/auth/password-input';

export function SetPasswordForm() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<NonNullable<SetPasswordResult['fieldErrors']>>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    const result = await setPasswordAction({ password, confirmPassword });
    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setStatus('idle');
      return;
    }
    setFieldErrors({});
    setStatus('done');
  }

  if (status === 'done') {
    return (
      <Alert>
        <AlertDescription>
          Password saved. You can now log in with your email and password.{' '}
          <Link href="/app" className="font-medium underline">
            Go to dashboard
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      <PasswordInput
        id="new-password"
        label="New Password"
        autoComplete="new-password"
        value={password}
        onChange={setPassword}
        error={fieldErrors.password}
      />
      <PasswordInput
        id="confirm-new-password"
        label="Confirm New Password"
        autoComplete="new-password"
        value={confirmPassword}
        onChange={setConfirmPassword}
        error={fieldErrors.confirmPassword}
      />
      <Button type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Saving…' : 'Save Password'}
      </Button>
    </form>
  );
}

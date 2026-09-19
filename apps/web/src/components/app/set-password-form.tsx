'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Alert, AlertDescription, Button } from '@growth-agent/ui';
import { setPasswordAction, type SetPasswordResult } from '@/server/auth-actions';
import { PasswordInput } from '@/components/auth/password-input';

export function SetPasswordForm({ requireCurrent = false }: { requireCurrent?: boolean }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(0);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<NonNullable<SetPasswordResult['fieldErrors']>>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setError(null);
    const result = await setPasswordAction({
      currentPassword: requireCurrent ? currentPassword : undefined,
      password,
      confirmPassword,
    });
    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setError(result.error ?? null);
      setStatus('idle');
      return;
    }
    setFieldErrors({});
    setRevoked(result.otherSessionsRevoked ?? 0);
    setStatus('done');
  }

  if (status === 'done') {
    return (
      <Alert>
        <AlertDescription>
          Password saved.{' '}
          {revoked > 0
            ? `${revoked} other session${revoked === 1 ? ' was' : 's were'} signed out. `
            : 'Other sessions were signed out. '}
          <Link href="/app" className="font-medium underline">
            Go to dashboard
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      {requireCurrent ? (
        <PasswordInput
          id="current-password"
          label="Current Password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={setCurrentPassword}
          error={fieldErrors.currentPassword}
        />
      ) : null}
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
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={status === 'submitting'}>
        {status === 'submitting' ? 'Saving…' : 'Save Password'}
      </Button>
    </form>
  );
}

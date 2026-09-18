'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Button, Input, Label, Separator } from '@growth-agent/ui';
import { signUpAction, type SignUpResult } from '@/server/auth-actions';
import { CheckEmailNotice } from './check-email-notice';
import { PasswordInput } from './password-input';

export function SignupForm({ google = false }: { google?: boolean }) {
  const params = useSearchParams();
  const callbackUrl = params.get('callbackUrl') ?? '/app';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<NonNullable<SignUpResult['fieldErrors']>>({});
  const [status, setStatus] = useState<'idle' | 'submitting' | 'sent'>('idle');

  async function submit() {
    setStatus('submitting');
    const result = await signUpAction({ name, email, password, confirmPassword });
    if (!result.ok) {
      setFieldErrors(result.fieldErrors ?? {});
      setStatus('idle');
      return;
    }
    setFieldErrors({});
    setStatus('sent');
  }

  if (status === 'sent') {
    return <CheckEmailNotice email={email} onResend={submit} />;
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Create your account</h1>
        <p className="text-muted-foreground text-sm">
          We&apos;ll email you a link to verify your account.
        </p>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3"
      >
        <div className="space-y-1.5">
          <Label htmlFor="name">Full Name</Label>
          <Input
            id="name"
            autoComplete="name"
            placeholder="Jane Doe"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={fieldErrors.name ? true : undefined}
            required
          />
          {fieldErrors.name ? (
            <p role="alert" className="text-destructive text-xs">
              {fieldErrors.name}
            </p>
          ) : null}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={fieldErrors.email ? true : undefined}
            required
          />
          {fieldErrors.email ? (
            <p role="alert" className="text-destructive text-xs">
              {fieldErrors.email}
            </p>
          ) : null}
        </div>
        <PasswordInput
          id="password"
          label="Password"
          autoComplete="new-password"
          value={password}
          onChange={setPassword}
          error={fieldErrors.password}
        />
        <PasswordInput
          id="confirm-password"
          label="Confirm Password"
          autoComplete="new-password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          error={fieldErrors.confirmPassword}
        />
        <Button type="submit" className="w-full" disabled={status === 'submitting'}>
          {status === 'submitting' ? 'Creating account…' : 'Create Account'}
        </Button>
      </form>

      {google ? (
        <>
          <div className="relative">
            <Separator />
            <span className="bg-background text-muted-foreground absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 px-2 text-xs uppercase">
              or
            </span>
          </div>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void signIn('google', { callbackUrl })}
          >
            Continue with Google
          </Button>
        </>
      ) : null}

      <p className="text-muted-foreground text-center text-xs">
        By continuing you agree to our terms and acknowledge our privacy policy.
      </p>
    </div>
  );
}

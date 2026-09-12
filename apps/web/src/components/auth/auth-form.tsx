'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Alert, AlertDescription, Button, Input, Label, Separator } from '@growth-agent/ui';

type Mode = 'login' | 'signup';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AuthForm({
  mode,
  devLogin = false,
  google = false,
}: {
  mode: Mode;
  devLogin?: boolean;
  google?: boolean;
}) {
  const params = useSearchParams();
  const callbackUrl = params.get('callbackUrl') ?? '/app';
  const reason = params.get('reason');

  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(email)) {
      setStatus('error');
      setMessage('Enter a valid email address.');
      return;
    }
    setStatus('sending');
    setMessage(null);
    const res = await signIn('nodemailer', { email, redirect: false, callbackUrl });
    if (res?.error) {
      setStatus('error');
      setMessage('Could not send the sign-in link. Please try again.');
    } else {
      setStatus('sent');
    }
  }

  async function devSignIn() {
    if (!EMAIL_RE.test(email)) {
      setStatus('error');
      setMessage('Enter a seeded user email (e.g. owner@example.com).');
      return;
    }
    await signIn('dev-credentials', { email, callbackUrl });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">
          {mode === 'login' ? 'Log in to Growth Agent' : 'Create your account'}
        </h1>
        <p className="text-muted-foreground text-sm">
          {mode === 'login'
            ? 'We’ll email you a one-time sign-in link.'
            : 'Enter your email — we’ll send a link to finish signing up.'}
        </p>
      </div>

      {reason === 'session_expired' ? (
        <Alert>
          <AlertDescription>Your session expired. Please sign in again.</AlertDescription>
        </Alert>
      ) : null}

      {status === 'sent' ? (
        <Alert>
          <AlertDescription>
            Check <span className="font-medium">{email}</span> for a sign-in link. In local
            development the link is printed to the server console.
          </AlertDescription>
        </Alert>
      ) : (
        <form onSubmit={sendMagicLink} className="space-y-3">
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
          {status === 'error' && message ? (
            <p role="alert" className="text-destructive text-sm">
              {message}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={status === 'sending'}>
            {status === 'sending' ? 'Sending…' : 'Send sign-in link'}
          </Button>
        </form>
      )}

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

      {devLogin ? (
        <Button variant="ghost" className="w-full text-xs" onClick={() => void devSignIn()}>
          Dev sign-in (seeded users only)
        </Button>
      ) : null}

      <p className="text-muted-foreground text-center text-xs">
        By continuing you agree to our terms and acknowledge our privacy policy.
      </p>
    </div>
  );
}

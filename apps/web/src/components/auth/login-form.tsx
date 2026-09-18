'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { signIn } from 'next-auth/react';
import {
  Alert,
  AlertDescription,
  Button,
  Input,
  Label,
  Separator,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@growth-agent/ui';
import { resendVerificationEmailAction } from '@/server/auth-actions';
import { CheckEmailNotice } from './check-email-notice';
import { PasswordInput } from './password-input';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginForm({
  devLogin = false,
  google = false,
}: {
  devLogin?: boolean;
  google?: boolean;
}) {
  const params = useSearchParams();
  const callbackUrl = params.get('callbackUrl') ?? '/app';
  const reason = params.get('reason');

  // Password tab state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pwStatus, setPwStatus] = useState<'idle' | 'submitting' | 'error' | 'unverified'>('idle');
  const [pwMessage, setPwMessage] = useState<string | null>(null);

  // Magic-link tab state (unchanged behavior from before)
  const [linkEmail, setLinkEmail] = useState('');
  const [linkStatus, setLinkStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    setPwStatus('submitting');
    setPwMessage(null);
    const res = await signIn('password', { email, password, redirect: false, callbackUrl });
    if (res?.error) {
      if (res.code === 'email-not-verified') {
        setPwStatus('unverified');
      } else {
        setPwStatus('error');
        setPwMessage('Invalid email or password.');
      }
    }
    // On success, next-auth redirects via the session; nothing else to do.
  }

  async function sendMagicLink(e: React.FormEvent) {
    e.preventDefault();
    if (!EMAIL_RE.test(linkEmail)) {
      setLinkStatus('error');
      return;
    }
    setLinkStatus('sending');
    const res = await signIn('nodemailer', { email: linkEmail, redirect: false, callbackUrl });
    setLinkStatus(res?.error ? 'error' : 'sent');
  }

  async function devSignIn() {
    if (!EMAIL_RE.test(email)) return;
    await signIn('dev-credentials', { email, callbackUrl });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1.5 text-center">
        <h1 className="text-xl font-semibold tracking-tight">Welcome back</h1>
      </div>

      {reason === 'session_expired' ? (
        <Alert>
          <AlertDescription>Your session expired. Please sign in again.</AlertDescription>
        </Alert>
      ) : null}

      {pwStatus === 'unverified' ? (
        <CheckEmailNotice
          email={email}
          onResend={() => resendVerificationEmailAction(email).then(() => undefined)}
        />
      ) : (
        <Tabs defaultValue="password">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="password">Password</TabsTrigger>
            <TabsTrigger value="magic-link">Magic Link</TabsTrigger>
          </TabsList>

          <TabsContent value="password" className="space-y-3 pt-3">
            <form onSubmit={submitPassword} className="space-y-3">
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
              <PasswordInput
                id="password"
                label="Password"
                autoComplete="current-password"
                value={password}
                onChange={setPassword}
              />
              {pwStatus === 'error' && pwMessage ? (
                <p role="alert" className="text-destructive text-sm">
                  {pwMessage}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={pwStatus === 'submitting'}>
                {pwStatus === 'submitting' ? 'Logging in…' : 'Log In'}
              </Button>
            </form>
            <p className="text-center text-sm">
              <Link href="/forgot-password" className="text-muted-foreground underline">
                Forgot password?
              </Link>
            </p>
          </TabsContent>

          <TabsContent value="magic-link" className="space-y-3 pt-3">
            {linkStatus === 'sent' ? (
              <Alert>
                <AlertDescription>
                  Check <span className="font-medium">{linkEmail}</span> for a sign-in link.
                </AlertDescription>
              </Alert>
            ) : (
              <form onSubmit={sendMagicLink} className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="link-email">Email</Label>
                  <Input
                    id="link-email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={linkEmail}
                    onChange={(e) => setLinkEmail(e.target.value)}
                    required
                  />
                </div>
                {linkStatus === 'error' ? (
                  <p role="alert" className="text-destructive text-sm">
                    Could not send the sign-in link. Please try again.
                  </p>
                ) : null}
                <Button type="submit" className="w-full" disabled={linkStatus === 'sending'}>
                  {linkStatus === 'sending' ? 'Sending…' : 'Send Magic Link'}
                </Button>
              </form>
            )}
          </TabsContent>
        </Tabs>
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

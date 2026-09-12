import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthForm } from '@/components/auth/auth-form';

export const metadata: Metadata = { title: 'Log in' };

export default function LoginPage() {
  const devLogin = process.env.AUTH_DEV_LOGIN === 'true' && process.env.NODE_ENV !== 'production';
  const google = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <AuthForm mode="login" devLogin={devLogin} google={google} />
      </Suspense>
      <p className="text-muted-foreground text-center text-sm">
        New here?{' '}
        <Link href="/signup" className="text-foreground font-medium underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}

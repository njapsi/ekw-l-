import { Suspense } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { SignupForm } from '@/components/auth/signup-form';

export const metadata: Metadata = { title: 'Sign up' };

export default function SignupPage() {
  const google = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  );
  return (
    <div className="space-y-6">
      <Suspense fallback={null}>
        <SignupForm google={google} />
      </Suspense>
      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <Link href="/login" className="text-foreground font-medium underline">
          Log in
        </Link>
      </p>
    </div>
  );
}

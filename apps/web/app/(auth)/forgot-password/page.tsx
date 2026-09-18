import Link from 'next/link';
import type { Metadata } from 'next';
import { ForgotPasswordForm } from '@/components/auth/forgot-password-form';

export const metadata: Metadata = { title: 'Reset password' };

export default function ForgotPasswordPage() {
  return (
    <div className="space-y-6">
      <ForgotPasswordForm />
      <p className="text-muted-foreground text-center text-sm">
        <Link href="/login" className="text-foreground font-medium underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}

import type { ReactNode } from 'react';
import Link from 'next/link';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="container flex h-14 items-center">
        <Link href="/" className="flex items-center gap-2 text-sm font-semibold">
          <span className="bg-primary inline-block size-5 rounded" aria-hidden />
          Growth Agent
        </Link>
      </header>
      <main className="container flex flex-1 items-center justify-center py-12">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Standalone output is for the Docker image (Linux). Enabling it on Windows
  // trips an EPERM on symlink creation, so it is opt-in via env.
  output: process.env.NEXT_OUTPUT_STANDALONE === '1' ? 'standalone' : undefined,
  // Trace from the monorepo root so the standalone bundle picks up the hoisted
  // workspace packages, and force-include the Prisma query engine (the file
  // tracer misses the native binary). See docs/DEPLOYMENT.md §13.
  outputFileTracingRoot: resolve(here, '../..'),
  // Globs are resolved from `outputFileTracingRoot` (the monorepo root).
  outputFileTracingIncludes: {
    '/**': [
      'node_modules/.pnpm/@prisma+client*/node_modules/.prisma/client/*',
      'node_modules/.pnpm/@prisma+client*/node_modules/@prisma/client/**',
      'node_modules/.prisma/client/*',
    ],
  },
  transpilePackages: [
    '@growth-agent/core',
    '@growth-agent/ai',
    '@growth-agent/db',
    '@growth-agent/ui',
    '@growth-agent/services',
    '@growth-agent/observability',
  ],
  // Workspace packages use NodeNext-style `.js` import specifiers that point at
  // `.ts`/`.tsx` source. Teach webpack (and Turbopack) to resolve them.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
      '.jsx': ['.tsx', '.jsx'],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.mjs'],
  },
  async headers() {
    const isProd = process.env.NODE_ENV === 'production';

    // Content-Security-Policy (SECURITY-AUDIT.md M-1, docs/SECURITY.md §6).
    // The Next.js App Router emits inline bootstrap/hydration <script> and
    // styled-jsx / Tailwind inline styles, so `script-src` / `style-src` keep
    // `'unsafe-inline'`; `'unsafe-eval'` is dev-only (react-refresh). This
    // still blocks every external script/frame/object origin, locks the
    // document base, and constrains form submission. A nonce-based strict CSP
    // is tracked as a follow-up.
    const csp = [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src 'none'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      ...(isProd ? ['upgrade-insecure-requests'] : []),
    ].join('; ');

    const securityHeaders = [
      { key: 'Content-Security-Policy', value: csp },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
      },
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    ];
    if (isProd) {
      securityHeaders.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      });
    }
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

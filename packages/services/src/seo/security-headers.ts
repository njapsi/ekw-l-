/**
 * Response security-header analysis (PAGE ANALYSIS: "security headers", "HTTPS").
 * Descriptive only — we report what is present/absent and why it matters; we
 * never claim a header change affects rankings.
 */
export interface SecurityHeaderReport {
  isHttps: boolean;
  hsts: boolean;
  hstsLongMaxAge: boolean;
  contentTypeOptions: boolean;
  frameProtection: boolean;
  referrerPolicy: boolean;
  csp: boolean;
  cspFrameAncestors: boolean;
  permissionsPolicy: boolean;
  /** Header names (lowercased) that expose stack detail. */
  disclosureHeaders: string[];
}

type Headers = Record<string, string | string[] | undefined>;

function get(headers: Headers, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v.join(', ');
  return v ?? null;
}

export function analyzeSecurityHeaders(finalUrl: string, headers: Headers): SecurityHeaderReport {
  const isHttps = finalUrl.startsWith('https://');
  const hstsRaw = get(headers, 'strict-transport-security');
  const csp = get(headers, 'content-security-policy');
  const xfo = get(headers, 'x-frame-options');

  const maxAgeMatch = hstsRaw?.match(/max-age=(\d+)/i);
  const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : 0;

  const disclosure: string[] = [];
  for (const h of ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version']) {
    if (get(headers, h)) disclosure.push(h);
  }

  return {
    isHttps,
    hsts: Boolean(hstsRaw) && isHttps,
    hstsLongMaxAge: maxAge >= 15_552_000, // 180 days
    contentTypeOptions: (get(headers, 'x-content-type-options') ?? '').toLowerCase() === 'nosniff',
    frameProtection: Boolean(xfo) || /frame-ancestors/i.test(csp ?? ''),
    referrerPolicy: Boolean(get(headers, 'referrer-policy')),
    csp: Boolean(csp),
    cspFrameAncestors: /frame-ancestors/i.test(csp ?? ''),
    permissionsPolicy: Boolean(
      get(headers, 'permissions-policy') || get(headers, 'feature-policy'),
    ),
    disclosureHeaders: disclosure,
  };
}

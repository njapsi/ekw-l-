import { AppError } from '../errors.js';

/**
 * Canonicalize a user-entered WordPress address.
 *
 * - HTTPS only. An Application Password is sent as HTTP Basic auth on every
 *   request; over plain HTTP that is the account password in cleartext.
 *   WordPress itself refuses application passwords on non-HTTPS sites for the
 *   same reason (outside local development).
 * - No credentials, query or fragment — those have no business in a site root
 *   and a `user:pass@host` URL is a classic credential-smuggling vector.
 * - A sub-directory install (`https://example.com/blog`) is preserved; the
 *   REST API lives under that path.
 */
export function normalizeSiteUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw AppError.validation('Enter your WordPress site address.');
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw AppError.validation('That does not look like a web address.');
  }
  if (url.protocol !== 'https:') {
    throw AppError.validation(
      'WordPress must be connected over https:// — an application password sent over plain http is readable by anyone on the network.',
    );
  }
  if (url.username || url.password) {
    throw AppError.validation('Remove the username/password from the address; enter them below.');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/wp-(admin|json|login\.php).*$/i, '');
  return `https://${url.host.toLowerCase()}${path}`;
}

/**
 * Build a REST API URL using the `?rest_route=` form. It works on every
 * WordPress install regardless of permalink settings, unlike `/wp-json/`,
 * which 404s on sites still using "plain" permalinks.
 */
export function restUrl(siteUrl: string, route: string, query: Record<string, string> = {}): URL {
  const url = new URL(`${siteUrl}/`);
  url.searchParams.set('rest_route', route);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return url;
}

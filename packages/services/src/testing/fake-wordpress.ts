/**
 * A fake WordPress REST API served through the injectable `WpTransport`, so
 * WordPress tests exercise the real client, URL building, auth header, JSON
 * validation and pagination — without a socket. Test-only.
 */
import type { WpRawRequest, WpRawResponse, WpTransport } from '../wordpress/http.js';
import type { DnsLookupFn } from '../seo/ssrf.js';

export interface FakePost {
  id: number;
  status: string;
  title: string;
  excerpt?: string;
  modified_gmt?: string;
}

export interface FakeWordPressOptions {
  username?: string;
  password?: string;
  capabilities?: Record<string, boolean>;
  namespaces?: string[];
  posts?: FakePost[];
  pages?: FakePost[];
  /** Force a status for every request (e.g. 503, 301). */
  forceStatus?: number;
  location?: string;
  nonJson?: boolean;
}

/** Resolves every host to a public address (TEST-NET would be blocked). */
export const publicLookup: DnsLookupFn = () =>
  Promise.resolve([{ address: '93.184.216.34', family: 4 }]);
export const privateLookup: DnsLookupFn = () =>
  Promise.resolve([{ address: '10.0.0.5', family: 4 }]);

export function fakeWordPress(opts: FakeWordPressOptions = {}) {
  const username = opts.username ?? 'editor';
  const password = opts.password ?? 'abcdabcdabcdabcdabcdabcd';
  const state = {
    posts: [...(opts.posts ?? [])],
    pages: [...(opts.pages ?? [])],
    revoked: [] as string[],
    nextId: 1000,
  };
  const calls: WpRawRequest[] = [];

  const json = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): WpRawResponse => ({
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    truncated: false,
  });

  const handle = (req: WpRawRequest): WpRawResponse => {
    calls.push(req);
    if (opts.forceStatus) {
      return {
        status: opts.forceStatus,
        headers: opts.location ? { location: opts.location } : {},
        body: opts.nonJson ? '<html>blocked</html>' : '{"code":"forced","message":"forced"}',
        truncated: false,
      };
    }
    if (opts.nonJson) {
      return {
        status: 200,
        headers: { 'content-type': 'text/html' },
        body: '<html></html>',
        truncated: false,
      };
    }
    const url = new URL(req.url);
    const route = url.searchParams.get('rest_route') ?? '';
    const authed =
      req.headers.authorization ===
      `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

    if (route === '/') {
      return json(200, {
        name: 'Test Blog',
        namespaces: opts.namespaces ?? ['oembed/1.0', 'wp/v2'],
      });
    }
    if (!authed) {
      return json(401, {
        code: 'incorrect_password',
        message: 'The provided password is an invalid application password.',
      });
    }
    if (route === '/wp/v2/users/me') {
      return json(200, {
        id: 7,
        name: 'Editor',
        capabilities: opts.capabilities ?? { read: true, edit_posts: true, publish_posts: true },
      });
    }
    if (route === '/wp/v2/users/me/application-passwords/introspect') {
      return json(200, { uuid: 'app-uuid-1' });
    }
    const revoke = route.match(/^\/wp\/v2\/users\/me\/application-passwords\/(.+)$/);
    if (revoke && req.method === 'DELETE') {
      state.revoked.push(decodeURIComponent(revoke[1] ?? ''));
      return json(200, { deleted: true });
    }
    const coll = route.match(/^\/wp\/v2\/(posts|pages)$/);
    if (coll) {
      const list = coll[1] === 'pages' ? state.pages : state.posts;
      if (req.method === 'POST') {
        const body = JSON.parse(req.body ?? '{}') as { title: string; status: string };
        const created = { id: state.nextId++, status: body.status, title: body.title };
        list.push(created);
        return json(201, render(created));
      }
      const perPage = Number(url.searchParams.get('per_page') ?? 10);
      const page = Number(url.searchParams.get('page') ?? 1);
      const totalPages = Math.max(1, Math.ceil(list.length / perPage));
      const slice = list.slice((page - 1) * perPage, page * perPage);
      return json(200, slice.map(render), { 'x-wp-totalpages': String(totalPages) });
    }
    const one = route.match(/^\/wp\/v2\/(posts|pages)\/(\d+)$/);
    if (one) {
      const list = one[1] === 'pages' ? state.pages : state.posts;
      const item = list.find((p) => p.id === Number(one[2]));
      if (!item) return json(404, { code: 'rest_post_invalid_id', message: 'Invalid post ID.' });
      if (req.method === 'POST') {
        const body = JSON.parse(req.body ?? '{}') as Partial<FakePost>;
        if (body.status) item.status = body.status;
        if (body.title) item.title = body.title;
      }
      return json(200, render(item));
    }
    return json(404, { code: 'rest_no_route', message: 'No route was found.' });
  };
  const transport: WpTransport = (req) => Promise.resolve(handle(req));

  function render(p: FakePost) {
    return {
      id: p.id,
      status: p.status,
      link: `https://blog.example.com/?p=${p.id}`,
      slug: `post-${p.id}`,
      modified_gmt: p.modified_gmt ?? '2026-09-01T10:00:00',
      title: { rendered: p.title, raw: p.title },
      excerpt: { rendered: `<p>${p.excerpt ?? 'Excerpt'}</p>` },
    };
  }

  return { transport, calls, state, username, password };
}

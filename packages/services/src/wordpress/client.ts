import { z } from 'zod';
import { IntegrationApiError } from '../integrations/resilience.js';
import type { DnsLookupFn } from '../seo/ssrf.js';
import { type WpAuth, type WpTransport, wpRequest } from './http.js';

/**
 * Typed client over the WordPress core REST API (`wp/v2`). Every response is
 * Zod-validated; a shape we do not recognise is an error, never a guess.
 */

const Rendered = z.object({ rendered: z.string().optional(), raw: z.string().optional() });

export const SiteInfo = z.object({
  name: z.string().default(''),
  description: z.string().optional(),
  url: z.string().optional(),
  home: z.string().optional(),
  namespaces: z.array(z.string()).default([]),
  authentication: z.unknown().optional(),
});
export type SiteInfo = z.infer<typeof SiteInfo>;

export const Me = z.object({
  id: z.number(),
  name: z.string().optional(),
  roles: z.array(z.string()).optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
});
export type Me = z.infer<typeof Me>;

export const WpPost = z.object({
  id: z.number(),
  status: z.string(),
  link: z.string().optional(),
  slug: z.string().optional(),
  modified_gmt: z.string().optional(),
  title: Rendered.optional(),
  excerpt: Rendered.optional(),
  content: Rendered.optional(),
});
export type WpPost = z.infer<typeof WpPost>;

export type WpContentKind = 'posts' | 'pages';

export interface WordPressClientOptions {
  transport?: WpTransport;
  lookup?: DnsLookupFn;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, what: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new IntegrationApiError(
      'wordpress',
      'server',
      `Unexpected ${what} response from WordPress (fields: ${r.error.issues
        .map((i) => i.path.join('.'))
        .slice(0, 5)
        .join(', ')}).`,
    );
  }
  return r.data;
}

export class WordPressClient {
  constructor(
    private readonly siteUrl: string,
    private readonly auth: WpAuth | undefined,
    private readonly opts: WordPressClientOptions = {},
  ) {}

  private req<T>(route: string, o: Parameters<typeof wpRequest>[2] = {}) {
    return wpRequest<T>(this.siteUrl, route, {
      ...o,
      auth: this.auth,
      transport: this.opts.transport,
      lookup: this.opts.lookup,
    });
  }

  /** Public REST index: proves this is WordPress and that wp/v2 is enabled. */
  async getSiteInfo(): Promise<SiteInfo> {
    const { data } = await wpRequest(this.siteUrl, '/', {
      transport: this.opts.transport,
      lookup: this.opts.lookup,
    });
    return parse(SiteInfo, data, 'site index');
  }

  /** The authenticated user, with capabilities (needs `context=edit`). */
  async getMe(): Promise<Me> {
    const { data } = await this.req('/wp/v2/users/me', { query: { context: 'edit' } });
    return parse(Me, data, 'current user');
  }

  async listContent(
    kind: WpContentKind,
    page: number,
    opts: { edit: boolean; perPage?: number },
  ): Promise<{ items: WpPost[]; totalPages: number }> {
    const query: Record<string, string> = {
      per_page: String(opts.perPage ?? 100),
      page: String(page),
      orderby: 'modified',
      order: 'desc',
      _fields: 'id,status,link,slug,modified_gmt,title,excerpt',
    };
    if (opts.edit) {
      query.context = 'edit';
      query.status = 'publish,future,draft,pending,private';
    }
    const { data, headers } = await this.req(`/wp/v2/${kind}`, { query });
    const items = parse(z.array(WpPost), data, kind);
    const raw = headers['x-wp-totalpages'];
    const totalPages = Number(Array.isArray(raw) ? raw[0] : raw) || 1;
    return { items, totalPages };
  }

  async getPost(kind: WpContentKind, id: number): Promise<WpPost> {
    const { data } = await this.req(`/wp/v2/${kind}/${id}`, { query: { context: 'edit' } });
    return parse(WpPost, data, 'post');
  }

  async createPost(
    kind: WpContentKind,
    fields: { title: string; content: string; excerpt?: string; status: 'draft' },
  ): Promise<WpPost> {
    const { data } = await this.req(`/wp/v2/${kind}`, { method: 'POST', body: fields });
    return parse(WpPost, data, 'created post');
  }

  async updatePost(
    kind: WpContentKind,
    id: number,
    fields: Partial<{
      title: string;
      content: string;
      excerpt: string;
      slug: string;
      status: string;
    }>,
  ): Promise<WpPost> {
    const { data } = await this.req(`/wp/v2/${kind}/${id}`, { method: 'POST', body: fields });
    return parse(WpPost, data, 'updated post');
  }

  /** Which application password authenticated this request (WP 5.9+). */
  async introspectAppPassword(): Promise<string | null> {
    const { data } = await this.req('/wp/v2/users/me/application-passwords/introspect');
    const r = z.object({ uuid: z.string() }).safeParse(data);
    return r.success ? r.data.uuid : null;
  }

  async revokeAppPassword(uuid: string): Promise<void> {
    await this.req(`/wp/v2/users/me/application-passwords/${encodeURIComponent(uuid)}`, {
      method: 'DELETE',
    });
  }
}

// Site content is untrusted: an out-of-range code point (`&#99999999;`) would
// make `fromCodePoint` throw and abort a whole sync, so it decodes to U+FFFD.
function codePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '�';
}

/** Decode the handful of HTML entities WordPress puts in rendered titles. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d{1,8});/g, (_, n: string) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, n: string) => codePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Plain text from rendered HTML — for display and as agent evidence only. */
export function toPlainText(html: string | undefined, max: number): string {
  if (!html) return '';
  const text = decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function titleOf(p: WpPost): string {
  const raw = p.title?.raw ?? p.title?.rendered ?? '';
  return (p.title?.raw !== undefined ? raw : toPlainText(raw, 500)) || '(untitled)';
}

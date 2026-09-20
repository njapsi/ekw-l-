import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, WordPressSite } from '@growth-agent/db';
import { generateEncryptionKey } from '../crypto/tokens.js';
import { resetBreakers } from '../integrations/resilience.js';
import { fakeWordPress, privateLookup, publicLookup } from '../testing/fake-wordpress.js';
import { createMemoryDb } from '../testing/memory-db.js';
import { createDraft, executePublishPost, executeUpdatePost } from './actions.js';
import { decodeEntities, toPlainText } from './client.js';
import {
  checkWordPressSite,
  connectWordPressSite,
  detectCapabilities,
  disconnectWordPressSite,
} from './connect.js';
import { wpRequest } from './http.js';
import { wordPressState } from './state.js';
import { syncWordPressContent } from './sync.js';
import { normalizeSiteUrl, restUrl } from './url.js';

vi.mock('../audit/index.js', () => ({ recordAudit: vi.fn(async () => {}) }));

beforeEach(() => {
  process.env.ENCRYPTION_KEY = generateEncryptionKey();
  resetBreakers();
});

const SITE = 'https://blog.example.com';

function setup(opts: Parameters<typeof fakeWordPress>[0] = {}) {
  const wp = fakeWordPress(opts);
  const db = createMemoryDb();
  const clientOpts = { transport: wp.transport, lookup: publicLookup };
  return { wp, db, asDb: db as unknown as Db, clientOpts };
}

async function connected(opts: Parameters<typeof fakeWordPress>[0] = {}) {
  const s = setup(opts);
  const site = await connectWordPressSite(
    {
      organizationId: 'org_1',
      userId: 'u1',
      siteUrl: SITE,
      username: s.wp.username,
      applicationPassword: 'abcd abcd abcd abcd abcd abcd',
    },
    s.asDb,
    s.clientOpts,
  );
  return { ...s, site };
}

describe('normalizeSiteUrl', () => {
  it('canonicalises to an https origin, keeping a sub-directory install', () => {
    expect(normalizeSiteUrl('Blog.Example.com/')).toBe('https://blog.example.com');
    expect(normalizeSiteUrl('https://example.com/blog/')).toBe('https://example.com/blog');
    expect(normalizeSiteUrl('https://example.com/blog/wp-admin/post.php')).toBe(
      'https://example.com/blog',
    );
  });

  it('refuses plain http — the application password would travel in cleartext', () => {
    expect(() => normalizeSiteUrl('http://blog.example.com')).toThrow(/https/);
  });

  it('refuses credentials embedded in the URL', () => {
    expect(() => normalizeSiteUrl('https://admin:pw@blog.example.com')).toThrow(/username/);
  });

  it('builds permalink-independent rest_route URLs', () => {
    const u = restUrl('https://example.com/blog', '/wp/v2/posts', { page: '2' });
    expect(u.toString()).toBe('https://example.com/blog/?rest_route=%2Fwp%2Fv2%2Fposts&page=2');
  });
});

describe('wpRequest (SSRF-safe HTTP)', () => {
  it('never contacts a site that resolves to a private address', async () => {
    const wp = fakeWordPress();
    await expect(
      wpRequest(SITE, '/', { transport: wp.transport, lookup: privateLookup }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(wp.calls).toHaveLength(0);
  });

  it('pins the connection to the validated address', async () => {
    const wp = fakeWordPress();
    await wpRequest(SITE, '/', { transport: wp.transport, lookup: publicLookup });
    expect(wp.calls[0]?.pinnedIp).toBe('93.184.216.34');
  });

  it('refuses to follow a redirect (it would carry the credential elsewhere)', async () => {
    const wp = fakeWordPress({ forceStatus: 301, location: 'https://evil.example.net/' });
    await expect(
      wpRequest(SITE, '/wp/v2/users/me', {
        transport: wp.transport,
        lookup: publicLookup,
        auth: { username: 'a', password: 'b' },
      }),
    ).rejects.toThrow(/redirected the API request to https:\/\/evil\.example\.net/);
    expect(wp.calls).toHaveLength(1);
  });

  it('classifies a rejected credential as auth and does not retry it', async () => {
    const wp = fakeWordPress();
    await expect(
      wpRequest(SITE, '/wp/v2/users/me', {
        transport: wp.transport,
        lookup: publicLookup,
        auth: { username: 'editor', password: 'wrong' },
      }),
    ).rejects.toMatchObject({ kind: 'auth', status: 401 });
    expect(wp.calls).toHaveLength(1);
  });

  it('explains a non-JSON response (security plugin / cache)', async () => {
    const wp = fakeWordPress({ nonJson: true });
    await expect(
      wpRequest(SITE, '/', { transport: wp.transport, lookup: publicLookup }),
    ).rejects.toThrow(/did not return WordPress REST API JSON/);
  });

  it('never retries a POST (a retry could create a duplicate draft)', async () => {
    const wp = fakeWordPress({ forceStatus: 503 });
    await expect(
      wpRequest(SITE, '/wp/v2/posts', {
        method: 'POST',
        body: { title: 'x' },
        transport: wp.transport,
        lookup: publicLookup,
      }),
    ).rejects.toMatchObject({ kind: 'server' });
    expect(wp.calls).toHaveLength(1);
  });
});

describe('connectWordPressSite', () => {
  it('stores nothing when WordPress rejects the credential', async () => {
    const s = setup();
    await expect(
      connectWordPressSite(
        {
          organizationId: 'org_1',
          userId: 'u1',
          siteUrl: SITE,
          username: 'editor',
          applicationPassword: 'zzzz zzzz zzzz zzzz zzzz zzzz',
        },
        s.asDb,
        s.clientOpts,
      ),
    ).rejects.toThrow(/rejected the username or application password/);
    expect(s.db.wordPressSite.rows).toHaveLength(0);
  });

  it('rejects something that is obviously a login password, before any network call', async () => {
    const s = setup();
    await expect(
      connectWordPressSite(
        {
          organizationId: 'org_1',
          userId: 'u1',
          siteUrl: SITE,
          username: 'editor',
          applicationPassword: 'hunter2',
        },
        s.asDb,
        s.clientOpts,
      ),
    ).rejects.toThrow(/application password/);
    expect(s.wp.calls).toHaveLength(0);
  });

  it('refuses a site without the core REST API', async () => {
    const s = setup({ namespaces: ['oembed/1.0'] });
    await expect(
      connectWordPressSite(
        {
          organizationId: 'org_1',
          userId: 'u1',
          siteUrl: SITE,
          username: 'editor',
          applicationPassword: 'abcd abcd abcd abcd abcd abcd',
        },
        s.asDb,
        s.clientOpts,
      ),
    ).rejects.toThrow(/wp\/v2/);
  });

  it('encrypts the credential and records the detected capabilities', async () => {
    const { db, site } = await connected({
      capabilities: { read: true, edit_posts: true, publish_posts: false, manage_options: false },
    });
    const row = db.wordPressSite.rows[0] as WordPressSite;
    expect(row.credentialCipher).not.toContain('abcd');
    expect(JSON.stringify(row)).not.toContain('abcdabcdabcdabcdabcdabcd');
    expect(site.detectedCapabilities).toEqual(['read', 'edit_posts']);
    expect(site.siteName).toBe('Test Blog');
    expect(wordPressState(site)).toBe('CONNECTED');
  });

  it('reconnecting the same site updates it instead of duplicating it', async () => {
    const s = await connected();
    await connectWordPressSite(
      {
        organizationId: 'org_1',
        userId: 'u1',
        siteUrl: `${SITE}/`,
        username: 'editor',
        applicationPassword: 'abcd abcd abcd abcd abcd abcd',
      },
      s.asDb,
      s.clientOpts,
    );
    expect(s.db.wordPressSite.rows).toHaveLength(1);
  });
});

describe('detectCapabilities', () => {
  it('keeps only the capabilities that drive the model', () => {
    expect(
      detectCapabilities({
        read: true,
        publish_posts: true,
        manage_options: true,
        edit_posts: false,
      }),
    ).toEqual(['read', 'publish_posts']);
    expect(detectCapabilities(undefined)).toEqual([]);
  });
});

describe('checkWordPressSite', () => {
  it('marks the site as needing reconnection when the password was revoked', async () => {
    const s = await connected();
    const bad = fakeWordPress({ password: 'a-different-password-now' });
    const res = await checkWordPressSite(s.site, s.asDb, {
      transport: bad.transport,
      lookup: publicLookup,
    });
    expect(res.authFailed).toBe(true);
    const row = s.db.wordPressSite.rows[0] as WordPressSite;
    expect(row.status).toBe('EXPIRED');
    expect(wordPressState(row)).toBe('REAUTH_REQUIRED');
  });

  it('a transient failure degrades but keeps the credential', async () => {
    const s = await connected();
    const down = fakeWordPress({ forceStatus: 404 });
    const res = await checkWordPressSite(s.site, s.asDb, {
      transport: down.transport,
      lookup: publicLookup,
    });
    expect(res.ok).toBe(false);
    const row = s.db.wordPressSite.rows[0] as WordPressSite;
    expect(row.status).toBe('ACTIVE');
    expect(wordPressState(row)).toBe('DEGRADED');
  });
});

describe('syncWordPressContent', () => {
  it('mirrors posts and pages across pages of results, drafts included for editors', async () => {
    const posts = Array.from({ length: 150 }, (_, i) => ({
      id: i + 1,
      status: i % 10 === 0 ? 'draft' : 'publish',
      title: `Post ${i + 1}`,
    }));
    const s = await connected({ posts, pages: [{ id: 900, status: 'publish', title: 'About' }] });
    const res = await syncWordPressContent(s.site, s.asDb, s.clientOpts);
    expect(res).toEqual({ posts: 150, pages: 1, truncated: false });
    expect(s.db.wordPressContent.rows).toHaveLength(151);
    const draftCall = s.wp.calls.find((c) => c.url.includes('status=publish%2Cfuture%2Cdraft'));
    expect(draftCall).toBeTruthy();
  });

  it('removes content deleted in WordPress after a complete sync', async () => {
    const s = await connected({
      posts: [
        { id: 1, status: 'publish', title: 'A' },
        { id: 2, status: 'publish', title: 'B' },
      ],
    });
    await syncWordPressContent(s.site, s.asDb, s.clientOpts);
    s.wp.state.posts.splice(1, 1);
    await syncWordPressContent(s.site, s.asDb, s.clientOpts);
    expect(s.db.wordPressContent.rows.map((r) => r.wpId)).toEqual([1]);
  });

  it('decodes rendered titles and survives hostile entities', async () => {
    const s = await connected({
      posts: [
        { id: 1, status: 'publish', title: 'x', excerpt: 'Tom &amp; Jerry &#99999999; &#8217;s' },
      ],
    });
    await syncWordPressContent(s.site, s.asDb, s.clientOpts);
    expect(s.db.wordPressContent.rows[0]?.excerpt).toBe('Tom & Jerry � ’s');
  });
});

describe('entity helpers', () => {
  it('strips tags and caps length', () => {
    expect(toPlainText('<p>Hello <b>world</b></p>', 100)).toBe('Hello world');
    expect(toPlainText('a'.repeat(50), 10)).toHaveLength(10);
    expect(decodeEntities('&lt;script&gt;')).toBe('<script>');
  });
});

describe('write operations', () => {
  it('creates a draft (never a published post)', async () => {
    const s = await connected();
    const res = await createDraft(
      {
        organizationId: 'org_1',
        siteId: s.site.id,
        actorId: 'u1',
        db: s.asDb,
        clientOpts: s.clientOpts,
      },
      { title: 'New idea', content: 'Body' },
    );
    expect(res.status).toBe('draft');
    expect(s.wp.state.posts.find((p) => p.id === res.wpId)?.status).toBe('draft');
  });

  it('AGENT_DRY_RUN=true simulates a draft without any real WordPress call', async () => {
    const s = await connected();
    const callsBefore = s.wp.calls.length;
    process.env.AGENT_DRY_RUN = 'true';
    try {
      const res = await createDraft(
        {
          organizationId: 'org_1',
          siteId: s.site.id,
          actorId: 'u1',
          db: s.asDb,
          clientOpts: s.clientOpts,
        },
        { title: 'New idea', content: 'Body' },
      );
      expect(res).toMatchObject({ status: 'draft', dryRun: true });
      expect(s.wp.calls.length).toBe(callsBefore);
      expect(s.wp.state.posts.length).toBe(0);
    } finally {
      delete process.env.AGENT_DRY_RUN;
    }
  });

  it('dry-run still enforces the real capability check first — it never simulates past a denial', async () => {
    const s = await connected({ capabilities: { read: true } });
    process.env.AGENT_DRY_RUN = 'true';
    try {
      await expect(
        createDraft(
          {
            organizationId: 'org_1',
            siteId: s.site.id,
            actorId: 'u1',
            db: s.asDb,
            clientOpts: s.clientOpts,
          },
          { title: 'x' },
        ),
      ).rejects.toThrow(/edit_posts/);
    } finally {
      delete process.env.AGENT_DRY_RUN;
    }
  });

  it('refuses a draft when the WordPress user cannot edit posts', async () => {
    const s = await connected({ capabilities: { read: true } });
    await expect(
      createDraft(
        {
          organizationId: 'org_1',
          siteId: s.site.id,
          actorId: 'u1',
          db: s.asDb,
          clientOpts: s.clientOpts,
        },
        { title: 'x' },
      ),
    ).rejects.toThrow(/edit_posts/);
    expect(s.wp.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a site from another organization', async () => {
    const s = await connected();
    await expect(
      createDraft(
        {
          organizationId: 'org_OTHER',
          siteId: s.site.id,
          actorId: 'u1',
          db: s.asDb,
          clientOpts: s.clientOpts,
        },
        { title: 'x' },
      ),
    ).rejects.toThrow(/not found/);
  });

  it('publishes a draft, and publishing again is a no-op', async () => {
    const s = await connected({ posts: [{ id: 5, status: 'draft', title: 'D' }] });
    const ctx = {
      organizationId: 'org_1',
      siteId: s.site.id,
      actorId: 'u1',
      db: s.asDb,
      clientOpts: s.clientOpts,
    };
    const first = await executePublishPost(ctx, { wpId: 5 });
    expect(first.status).toBe('publish');
    const second = await executePublishPost(ctx, { wpId: 5 });
    expect(second.alreadyPublished).toBe(true);
  });

  it('will not publish a trashed / private item', async () => {
    const s = await connected({ posts: [{ id: 5, status: 'private', title: 'P' }] });
    await expect(
      executePublishPost(
        {
          organizationId: 'org_1',
          siteId: s.site.id,
          actorId: 'u1',
          db: s.asDb,
          clientOpts: s.clientOpts,
        },
        { wpId: 5 },
      ),
    ).rejects.toThrow(/Only drafts or pending/);
  });

  it('editing published content needs edit_published_posts', async () => {
    const s = await connected({
      capabilities: { read: true, edit_posts: true },
      posts: [{ id: 5, status: 'publish', title: 'Live' }],
    });
    await expect(
      executeUpdatePost(
        {
          organizationId: 'org_1',
          siteId: s.site.id,
          actorId: 'u1',
          db: s.asDb,
          clientOpts: s.clientOpts,
        },
        { wpId: 5, title: 'Changed' },
      ),
    ).rejects.toThrow(/edit_published_posts/);
  });

  it('rejects an update that changes nothing, with a readable message', async () => {
    const s = await connected();
    await expect(
      executeUpdatePost(
        {
          organizationId: 'org_1',
          siteId: s.site.id,
          actorId: 'u1',
          db: s.asDb,
          clientOpts: s.clientOpts,
        },
        { wpId: 5 },
      ),
    ).rejects.toThrow('Nothing to change.');
  });
});

describe('disconnectWordPressSite', () => {
  it('revokes the application password upstream and scrubs the credential', async () => {
    const s = await connected({ posts: [{ id: 1, status: 'publish', title: 'A' }] });
    await syncWordPressContent(s.site, s.asDb, s.clientOpts);
    const res = await disconnectWordPressSite('org_1', s.site.id, 'u1', s.asDb, s.clientOpts);
    expect(res.revokedUpstream).toBe(true);
    expect(s.wp.state.revoked).toEqual(['app-uuid-1']);
    const row = s.db.wordPressSite.rows[0] as WordPressSite;
    expect(row.status).toBe('REVOKED');
    expect(row.credentialCipher).toBe('');
    expect(s.db.wordPressContent.rows).toHaveLength(0);
  });
});

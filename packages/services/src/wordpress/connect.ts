import { type Db, type WordPressSite, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { isStaleKeyId, open, seal } from '../crypto/tokens.js';
import { AppError } from '../errors.js';
import { IntegrationApiError } from '../integrations/resilience.js';
import { scrubSecrets } from '../observability/scrub.js';
import { type WordPressClientOptions, WordPressClient } from './client.js';
import { normalizeSiteUrl } from './url.js';

const log = createLogger('wordpress');

/**
 * The WordPress capabilities that drive Growth Agent's capability model. We
 * keep only these (a role's full capability map can run to hundreds of keys)
 * — they are what `resolveCapabilities` matches `requiredScopes` against.
 */
export const RELEVANT_WP_CAPABILITIES = [
  'read',
  'edit_posts',
  'edit_published_posts',
  'publish_posts',
  'edit_pages',
  'edit_published_pages',
  'publish_pages',
] as const;

export function detectCapabilities(caps: Record<string, boolean> | undefined): string[] {
  if (!caps) return [];
  return RELEVANT_WP_CAPABILITIES.filter((c) => caps[c] === true);
}

/** Turn a client error into a message the user can act on. */
export function explainWordPressError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof IntegrationApiError) {
    switch (err.kind) {
      case 'auth':
        return new AppError(
          'validation_failed',
          'WordPress rejected the username or application password. In WordPress go to Users → Profile → Application Passwords, create a new one, and paste it exactly (spaces are fine).',
        );
      case 'permission':
        return new AppError(
          'validation_failed',
          'WordPress refused API access for this user. A security plugin may be blocking the REST API, or the account lacks the needed role.',
        );
      case 'not_found':
        return new AppError(
          'validation_failed',
          'No WordPress REST API was found at that address. Check the site address, and that the REST API is not disabled.',
        );
      case 'circuit_open':
      case 'rate_limited':
        return new AppError('provider_unavailable', err.message);
      default:
        return new AppError('provider_unavailable', scrubSecrets(err.message));
    }
  }
  return new AppError('internal_error', 'Unexpected error talking to WordPress.', { cause: err });
}

export interface ConnectWordPressInput {
  organizationId: string;
  userId: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

/**
 * Verify, then store. Nothing is persisted unless WordPress itself accepted
 * the credential — a connection is never recorded on the user's say-so.
 */
export async function connectWordPressSite(
  input: ConnectWordPressInput,
  db: Db = prisma,
  clientOpts: WordPressClientOptions = {},
): Promise<WordPressSite> {
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const username = input.username.trim();
  // WordPress displays application passwords in space-separated groups and
  // accepts them with or without the spaces.
  const password = input.applicationPassword.replace(/\s+/g, '');
  if (!username) throw AppError.validation('Enter the WordPress username.');
  if (password.length < 16) {
    throw AppError.validation(
      'That does not look like an application password (24 characters). Create one under Users → Profile → Application Passwords — do not use your login password.',
    );
  }

  let siteName: string;
  let wpUserId: number;
  let capabilities: string[];
  try {
    const anon = new WordPressClient(siteUrl, undefined, clientOpts);
    const info = await anon.getSiteInfo();
    if (!info.namespaces.includes('wp/v2')) {
      throw AppError.validation(
        'This site does not expose the WordPress core REST API (wp/v2). It may be disabled by a plugin.',
      );
    }
    siteName = info.name;
    const authed = new WordPressClient(siteUrl, { username, password }, clientOpts);
    const me = await authed.getMe();
    wpUserId = me.id;
    capabilities = detectCapabilities(me.capabilities);
  } catch (err) {
    throw explainWordPressError(err);
  }

  const sealed = seal(password);
  const data = {
    siteName,
    username,
    credentialCipher: sealed.cipher,
    credentialIv: sealed.iv,
    credentialAuthTag: sealed.authTag,
    keyId: sealed.keyId,
    status: 'ACTIVE' as const,
    detectedCapabilities: capabilities,
    wpUserId,
    lastError: null,
    lastCheckAt: new Date(),
    lastCheckOk: true,
  };
  const existing = await db.wordPressSite.findUnique({
    where: { organizationId_siteUrl: { organizationId: input.organizationId, siteUrl } },
    select: { id: true },
  });
  const site = existing
    ? await db.wordPressSite.update({ where: { id: existing.id }, data })
    : await db.wordPressSite.create({
        data: { ...data, organizationId: input.organizationId, siteUrl, createdById: input.userId },
      });

  await recordAudit({
    organizationId: input.organizationId,
    actorId: input.userId,
    action: existing ? 'integration.reconnected' : 'integration.connected',
    targetType: 'wordpress_site',
    targetId: site.id,
    metadata: { provider: 'WORDPRESS', siteUrl, capabilities },
  });
  log.info({ siteId: site.id, capabilities }, 'wordpress site connected');
  return site;
}

/** Tenant-scoped lookup. */
export async function requireWordPressSite(
  organizationId: string,
  siteId: string,
  db: Db = prisma,
): Promise<WordPressSite> {
  const site = await db.wordPressSite.findUnique({ where: { id: siteId } });
  if (!site || site.organizationId !== organizationId) throw AppError.notFound('WordPress site');
  return site;
}

/** An authenticated client for a stored site. Never exposes the credential. */
export function clientForSite(
  site: WordPressSite,
  clientOpts: WordPressClientOptions = {},
): WordPressClient {
  if (site.status === 'REVOKED' || !site.credentialCipher) {
    throw new AppError('provider_unavailable', 'This WordPress site is disconnected.');
  }
  const password = open({
    cipher: site.credentialCipher,
    iv: site.credentialIv,
    authTag: site.credentialAuthTag,
    keyId: site.keyId,
  });
  return new WordPressClient(site.siteUrl, { username: site.username, password }, clientOpts);
}

export interface WordPressCheckResult {
  ok: boolean;
  capabilities: string[];
  error: string | null;
  authFailed: boolean;
}

/**
 * Re-validate a stored credential and refresh detected capabilities. A 401
 * marks the site EXPIRED (surfaced as REAUTH_REQUIRED — application
 * passwords cannot be refreshed, only replaced); any other failure leaves the
 * credential alone and records a failed check (DEGRADED).
 */
export async function checkWordPressSite(
  site: WordPressSite,
  db: Db = prisma,
  clientOpts: WordPressClientOptions = {},
): Promise<WordPressCheckResult> {
  try {
    const me = await clientForSite(site, clientOpts).getMe();
    const capabilities = detectCapabilities(me.capabilities);
    await db.wordPressSite.update({
      where: { id: site.id },
      data: {
        status: 'ACTIVE',
        detectedCapabilities: capabilities,
        lastError: null,
        lastCheckAt: new Date(),
        lastCheckOk: true,
      },
    });
    return { ok: true, capabilities, error: null, authFailed: false };
  } catch (err) {
    const authFailed = err instanceof IntegrationApiError && err.kind === 'auth';
    const message = scrubSecrets(err instanceof Error ? err.message : 'check failed').slice(0, 500);
    await db.wordPressSite.update({
      where: { id: site.id },
      data: {
        ...(authFailed ? { status: 'EXPIRED' as const } : {}),
        lastError: message,
        lastCheckAt: new Date(),
        lastCheckOk: false,
      },
    });
    return { ok: false, capabilities: site.detectedCapabilities, error: message, authFailed };
  }
}

/**
 * Disconnect: best-effort revoke of the application password on the site
 * itself (WP 5.9+ introspection), then scrub the stored credential. The row
 * is kept as REVOKED for the audit trail; its cached content is deleted.
 */
export async function disconnectWordPressSite(
  organizationId: string,
  siteId: string,
  userId: string,
  db: Db = prisma,
  clientOpts: WordPressClientOptions = {},
): Promise<{ revokedUpstream: boolean }> {
  const site = await requireWordPressSite(organizationId, siteId, db);
  let revokedUpstream = false;
  if (site.status !== 'REVOKED' && site.credentialCipher) {
    try {
      const client = clientForSite(site, clientOpts);
      const uuid = await client.introspectAppPassword();
      if (uuid) {
        await client.revokeAppPassword(uuid);
        revokedUpstream = true;
      }
    } catch (err) {
      log.warn(
        { siteId, err: err instanceof Error ? err.message : String(err) },
        'upstream application-password revocation failed (continuing)',
      );
    }
  }
  await db.wordPressSite.update({
    where: { id: site.id },
    data: {
      status: 'REVOKED',
      credentialCipher: '',
      credentialIv: '',
      credentialAuthTag: '',
      detectedCapabilities: [],
      lastError: null,
    },
  });
  await db.wordPressContent.deleteMany({ where: { organizationId, wordPressSiteId: site.id } });
  await recordAudit({
    organizationId,
    actorId: userId,
    action: 'integration.disconnected',
    targetType: 'wordpress_site',
    targetId: site.id,
    metadata: { provider: 'WORDPRESS', revokedUpstream },
  });
  return { revokedUpstream };
}

/** Re-seal a credential stored under a previous ENCRYPTION_KEY. */
export async function resealWordPressCredential(
  site: WordPressSite,
  db: Db = prisma,
): Promise<boolean> {
  if (!site.credentialCipher || !isStaleKeyId(site.keyId)) return false;
  const plain = open({
    cipher: site.credentialCipher,
    iv: site.credentialIv,
    authTag: site.credentialAuthTag,
    keyId: site.keyId,
  });
  const sealed = seal(plain);
  await db.wordPressSite.update({
    where: { id: site.id },
    data: {
      credentialCipher: sealed.cipher,
      credentialIv: sealed.iv,
      credentialAuthTag: sealed.authTag,
      keyId: sealed.keyId,
    },
  });
  return true;
}

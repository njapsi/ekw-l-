/**
 * Website ownership verification (docs/SEO-ENGINE.md §2 "Ownership gate"). A
 * full crawl only runs once the org has proven control of the domain via one of:
 *   - a DNS TXT record containing the verification token
 *   - an HTML token file at `/.well-known/growth-agent-verify.txt`
 *   - (future) a linked Google Search Console property
 *
 * Until then the planner restricts crawls to a shallow public sample.
 */
import { randomBytes } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { type Db, prisma } from '@growth-agent/db';
import { createLogger } from '@growth-agent/observability';
import { recordAudit } from '../audit/index.js';
import { AppError } from '../errors.js';
import { type FetchPageOptions, fetchPage } from './fetch.js';

const log = createLogger('seo.verify');

export const VERIFY_FILE_PATH = '/.well-known/growth-agent-verify.txt';
export const VERIFY_TXT_PREFIX = 'growth-agent-site-verification=';

export function generateVerificationToken(): string {
  return randomBytes(24).toString('hex');
}

export type TxtResolver = (hostname: string) => Promise<string[][]>;

const systemTxtResolver: TxtResolver = (hostname) => resolveTxt(hostname);

export interface VerifyDeps {
  db?: Db;
  txtResolver?: TxtResolver;
  fetchOptions?: FetchPageOptions;
}

export interface VerifyResult {
  verified: boolean;
  method: 'DNS_TXT' | 'HTML_FILE' | null;
  detail: string;
}

/**
 * Attempt to verify `websiteId` for `organizationId`. On success the `Website`
 * row is flipped to `verified = true` and an audit entry is written.
 */
export async function verifyWebsite(
  input: { organizationId: string; websiteId: string; userId: string },
  deps: VerifyDeps = {},
): Promise<VerifyResult> {
  const db = deps.db ?? prisma;
  const txtResolver = deps.txtResolver ?? systemTxtResolver;

  const site = await db.website.findFirst({
    where: { id: input.websiteId, organizationId: input.organizationId },
  });
  if (!site) throw AppError.notFound('Website');
  if (site.verified) {
    return {
      verified: true,
      method: site.verificationMethod as 'DNS_TXT' | 'HTML_FILE' | null,
      detail: 'Already verified.',
    };
  }

  const expected = `${VERIFY_TXT_PREFIX}${site.verificationToken}`;

  // 1. DNS TXT
  try {
    const records = await txtResolver(site.hostname);
    const flat = records.map((chunks) => chunks.join(''));
    if (flat.some((r) => r.trim() === expected || r.trim() === site.verificationToken)) {
      return finish(db, site.id, input, 'DNS_TXT', 'Found the DNS TXT record.');
    }
  } catch (e) {
    log.info({ websiteId: site.id, err: String(e) }, 'DNS TXT lookup failed (will try file)');
  }

  // 2. HTML token file
  const fileUrl = `${site.url.replace(/\/$/, '')}${VERIFY_FILE_PATH}`;
  const res = await fetchPage(fileUrl, { ...deps.fetchOptions, maxBytes: 4096 });
  if (res.ok && res.status === 200 && res.body.trim().includes(site.verificationToken)) {
    return finish(db, site.id, input, 'HTML_FILE', 'Found the verification file.');
  }

  return {
    verified: false,
    method: null,
    detail:
      'Neither the DNS TXT record nor the verification file was found. Publish one of them and try again (DNS can take a while to propagate).',
  };
}

async function finish(
  db: Db,
  websiteId: string,
  input: { organizationId: string; userId: string },
  method: 'DNS_TXT' | 'HTML_FILE',
  detail: string,
): Promise<VerifyResult> {
  await db.website.update({
    where: { id: websiteId },
    data: { verified: true, verificationMethod: method, verifiedAt: new Date() },
  });
  await recordAudit(
    {
      organizationId: input.organizationId,
      actorId: input.userId,
      action: 'seo.website.verified',
      targetType: 'website',
      targetId: websiteId,
      metadata: { method },
    },
    db,
  );
  return { verified: true, method, detail };
}

import 'server-only';
import { wordpress } from '@growth-agent/services';

type Site = Awaited<ReturnType<typeof wordpress.listWordPressSites>>[number];

export type WordPressState = { kind: 'not_connected' } | { kind: 'ready'; site: Site };

export async function loadWordPressState(organizationId: string): Promise<WordPressState> {
  const sites = await wordpress.listWordPressSites(organizationId);
  const site = sites[0] ?? null;
  if (!site) return { kind: 'not_connected' };
  return { kind: 'ready', site };
}

/**
 * Crawler kill switch (docs/SEO-ENGINE.md §2 "Kill switch"). A global env flag
 * plus a comma-separated per-org denylist, both read at crawl start. When
 * halted, no new crawl is planned or started and running crawls stop between
 * pages.
 */
export interface KillSwitchState {
  haltedGlobally: boolean;
  haltedOrgIds: Set<string>;
}

export function readKillSwitch(env: NodeJS.ProcessEnv = process.env): KillSwitchState {
  return {
    haltedGlobally: env.CRAWLER_HALT === '1' || env.CRAWLER_HALT === 'true',
    haltedOrgIds: new Set(
      (env.CRAWLER_HALT_ORG_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}

export function crawlingHalted(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const state = readKillSwitch(env);
  return state.haltedGlobally || state.haltedOrgIds.has(organizationId);
}

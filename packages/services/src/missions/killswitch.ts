/**
 * Growth Missions kill switch (Phase 12, §mission safety). Missions execute
 * real, unattended, multi-step actions across YouTube/TikTok/WordPress/SEO
 * (`missions/loop.ts::runMissionTick`) — the same class of risk the crawler
 * already has a global stop for (`seo/killswitch.ts`, `CRAWLER_HALT`). This
 * mirrors that exact shape rather than inventing a new one: a global env
 * flag plus a comma-separated per-org denylist, both read at tick time. When
 * halted, no new tick runs; a tick already in flight (mid-`await`) still
 * finishes, matching the crawler's own "stops between pages, not mid-page"
 * behavior.
 */
export interface MissionKillSwitchState {
  haltedGlobally: boolean;
  haltedOrgIds: Set<string>;
}

export function readMissionKillSwitch(env: NodeJS.ProcessEnv = process.env): MissionKillSwitchState {
  return {
    haltedGlobally: env.MISSIONS_HALT === '1' || env.MISSIONS_HALT === 'true',
    haltedOrgIds: new Set(
      (env.MISSIONS_HALT_ORG_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}

export function missionsHalted(
  organizationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const state = readMissionKillSwitch(env);
  return state.haltedGlobally || state.haltedOrgIds.has(organizationId);
}

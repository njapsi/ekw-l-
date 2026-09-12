// Client-safe copy of the channel labels (mirrors
// packages/services/src/monetization/schemas.ts CHANNEL_LABEL — kept here so
// client components never import the services package).
export const CHANNEL_LABEL: Record<string, string> = {
  PLATFORM_MONETIZATION: 'Platform monetization',
  SPONSORSHIP: 'Sponsorships',
  AFFILIATE: 'Affiliate marketing',
  DIGITAL_PRODUCT: 'Digital products',
  SERVICE: 'Services',
  MEMBERSHIP: 'Memberships',
  SUBSCRIPTION: 'Subscriptions',
  LEAD_GENERATION: 'Lead generation',
  CONSULTING: 'Consulting',
  COURSE: 'Courses',
  BRAND_PARTNERSHIP: 'Brand partnerships',
};

export const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABEL).map(([value, label]) => ({
  value,
  label,
}));

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

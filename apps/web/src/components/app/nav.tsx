import type { ComponentType } from 'react';
import {
  Bot,
  CheckSquare,
  Clock,
  CreditCard,
  DollarSign,
  FileText,
  Gauge,
  History,
  LayoutDashboard,
  Lightbulb,
  Music2,
  PenSquare,
  Plug,
  ShieldCheck,
  Target,
  User,
  Users,
  Youtube,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/** Grouped navigation (Phase 2 Part 27, redesigned Phase 3 Part 3/33). Every
 * destination existed before this phase; grouping and icons changed, no
 * feature was removed. Notifications moved to the header bell (Part 4/21's
 * own reference pattern), which remains the discoverable entry point
 * (`/app/notifications` is still a real route, just not duplicated here). */
export const APP_NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    items: [
      { href: '/app/dashboard', label: 'Home', icon: LayoutDashboard },
      { href: '/app/agent', label: 'AI Agent', icon: Bot },
    ],
  },
  {
    label: 'Growth',
    items: [
      { href: '/app/youtube', label: 'YouTube', icon: Youtube },
      { href: '/app/tiktok', label: 'TikTok', icon: Music2 },
      { href: '/app/seo', label: 'SEO', icon: Gauge },
      { href: '/app/wordpress', label: 'WordPress', icon: PenSquare },
      { href: '/app/monetization', label: 'Monetization', icon: DollarSign },
    ],
  },
  {
    label: 'Work',
    items: [
      { href: '/app/content', label: 'Content', icon: Lightbulb },
      { href: '/app/tasks', label: 'Tasks', icon: CheckSquare },
      { href: '/app/automations', label: 'Automations', icon: Clock },
      { href: '/app/reports', label: 'Reports', icon: FileText },
      { href: '/app/integrations/approvals', label: 'Approvals', icon: ShieldCheck },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/app/missions', label: 'Missions', icon: Target },
      { href: '/app/integrations', label: 'Connections', icon: Plug },
      { href: '/app/settings/members', label: 'Team', icon: Users },
      { href: '/app/settings/audit', label: 'Activity', icon: History },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/app/settings/account', label: 'Account', icon: User },
      { href: '/app/settings/security', label: 'Security', icon: ShieldCheck },
      { href: '/app/settings/ai-governance', label: 'AI Governance', icon: Bot },
      { href: '/app/settings/organization', label: 'Organization', icon: Users },
      { href: '/app/billing', label: 'Billing', icon: CreditCard },
    ],
  },
];

/** Flat list (kept for callers that do not render groups). */
export const APP_NAV: NavItem[] = APP_NAV_GROUPS.flatMap((g) => g.items);

/** The single most specific nav href matching the path (so /app/integrations/wordpress does not also light up Connections). */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const item of APP_NAV) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (!best || item.href.length > best.length) best = item.href;
    }
  }
  return best;
}

/** Primary mobile bottom-nav destinations (Part 33) — everything else moves
 * behind "More". */
export const MOBILE_PRIMARY_NAV: NavItem[] = [
  { href: '/app/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/app/agent', label: 'AI Agent', icon: Bot },
  { href: '/app/content', label: 'Content', icon: Lightbulb },
  { href: '/app/youtube', label: 'Growth', icon: Youtube },
];

import type { ComponentType } from 'react';
import {
  Bell,
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
  Settings,
  ShieldCheck,
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

/** Grouped navigation (Phase 2, Part 27). Every destination existed before. */
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
      { href: '/app/integrations/wordpress', label: 'WordPress', icon: PenSquare },
      { href: '/app/content', label: 'Content', icon: Lightbulb },
      { href: '/app/monetization', label: 'Monetization', icon: DollarSign },
    ],
  },
  {
    label: 'Operations',
    items: [
      { href: '/app/automations', label: 'Automations', icon: Clock },
      { href: '/app/tasks', label: 'Tasks', icon: CheckSquare },
      { href: '/app/reports', label: 'Reports', icon: FileText },
      { href: '/app/integrations/approvals', label: 'Approvals', icon: ShieldCheck },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/app/integrations', label: 'Connections', icon: Plug },
      { href: '/app/settings/members', label: 'Team', icon: Users },
      { href: '/app/settings/audit', label: 'Activity', icon: History },
      { href: '/app/notifications', label: 'Notifications', icon: Bell },
      { href: '/app/billing', label: 'Billing', icon: CreditCard },
      { href: '/app/settings', label: 'Settings', icon: Settings },
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

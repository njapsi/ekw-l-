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
  LayoutDashboard,
  Lightbulb,
  Music2,
  Plug,
  Settings,
  Youtube,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
}

export const APP_NAV: NavItem[] = [
  { href: '/app/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/app/agent', label: 'AI Agent', icon: Bot },
  { href: '/app/youtube', label: 'YouTube', icon: Youtube },
  { href: '/app/tiktok', label: 'TikTok', icon: Music2 },
  { href: '/app/seo', label: 'SEO', icon: Gauge },
  { href: '/app/content', label: 'Content', icon: Lightbulb },
  { href: '/app/monetization', label: 'Monetization', icon: DollarSign },
  { href: '/app/reports', label: 'Reports', icon: FileText },
  { href: '/app/automations', label: 'Automations', icon: Clock },
  { href: '/app/tasks', label: 'Tasks', icon: CheckSquare },
  { href: '/app/notifications', label: 'Notifications', icon: Bell },
  { href: '/app/integrations', label: 'Integrations', icon: Plug },
  { href: '/app/billing', label: 'Billing', icon: CreditCard },
  { href: '/app/settings', label: 'Settings', icon: Settings },
];

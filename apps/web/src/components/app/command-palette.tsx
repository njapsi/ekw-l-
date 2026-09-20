'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import {
  Bot,
  Check,
  Gauge,
  Lightbulb,
  LogOut,
  Music2,
  PenSquare,
  Rss,
  Settings,
  Youtube,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@growth-agent/ui';
import { switchOrgAction } from '@/server/org-actions';
import { APP_NAV_GROUPS } from './nav';
import type { OrgOption } from './org-switcher';

// cmdk only matches an item's visible text by default — "Home" would never
// match someone typing "dashboard". Extra search terms per nav destination
// close that gap without changing the visible label.
const NAV_KEYWORDS: Record<string, string[]> = {
  '/app/dashboard': ['dashboard', 'overview', 'home'],
  '/app/agent': ['chat', 'ai', 'assistant', 'conversation'],
  '/app/integrations/wordpress': ['wordpress', 'blog', 'posts'],
  '/app/integrations': ['connections', 'integrations', 'connect'],
  '/app/settings/members': ['team', 'members', 'invite'],
  '/app/settings/audit': ['activity', 'audit', 'log'],
};

/**
 * Global command palette (Part 23). `Cmd+K` / `Ctrl+K` opens it from
 * anywhere in the app shell. Covers navigation to every existing
 * destination plus the handful of common actions the brief calls out —
 * it does not (yet) search content/reports/conversations, which Part 22
 * explicitly scopes as future work ("design so it can scale").
 */
export function CommandPalette({
  organizations,
  activeOrgId,
  open,
  onOpenChange,
}: {
  organizations: OrgOption[];
  activeOrgId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const go = useCallback(
    (href: string) => {
      onOpenChange(false);
      router.push(href);
    },
    [router, onOpenChange],
  );

  function switchOrg(id: string) {
    if (id === activeOrgId) {
      onOpenChange(false);
      return;
    }
    onOpenChange(false);
    startTransition(async () => {
      const res = await switchOrgAction(id);
      if (!res.ok) return;
      router.push('/app/dashboard');
      router.refresh();
    });
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Search or jump to..." />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        <CommandGroup heading="Quick actions">
          <CommandItem onSelect={() => go('/app/agent')}>
            <Bot className="size-4" aria-hidden /> New conversation
          </CommandItem>
          <CommandItem onSelect={() => go('/app/integrations/youtube')}>
            <Youtube className="size-4" aria-hidden /> Connect YouTube
          </CommandItem>
          <CommandItem onSelect={() => go('/app/integrations/tiktok')}>
            <Music2 className="size-4" aria-hidden /> Connect TikTok
          </CommandItem>
          <CommandItem onSelect={() => go('/app/integrations/wordpress')}>
            <PenSquare className="size-4" aria-hidden /> Connect WordPress
          </CommandItem>
          <CommandItem onSelect={() => go('/app/seo')}>
            <Gauge className="size-4" aria-hidden /> Add website
          </CommandItem>
          <CommandItem onSelect={() => go('/app/content')}>
            <Lightbulb className="size-4" aria-hidden /> Create content
          </CommandItem>
          <CommandItem onSelect={() => go('/app/automations')}>
            <Rss className="size-4" aria-hidden /> Create automation
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        {APP_NAV_GROUPS.map((group) => (
          <CommandGroup key={group.label ?? 'top'} heading={group.label ?? 'Go to'}>
            {group.items.map((item) => (
              <CommandItem
                key={item.href}
                onSelect={() => go(item.href)}
                keywords={NAV_KEYWORDS[item.href]}
              >
                <item.icon className="size-4" aria-hidden />
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Organizations">
          {organizations.map((org) => (
            <CommandItem key={org.id} onSelect={() => switchOrg(org.id)}>
              <span className="flex-1">{org.name}</span>
              {org.id === activeOrgId ? <Check className="size-3.5" aria-hidden /> : null}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Account">
          <CommandItem onSelect={() => go('/app/settings/account')}>
            <Settings className="size-4" aria-hidden /> Open settings
          </CommandItem>
          <CommandItem onSelect={() => void signOut({ callbackUrl: '/login' })}>
            <LogOut className="size-4" aria-hidden /> Log out
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="text-muted-foreground flex items-center justify-end gap-1 border-t px-3 py-2 text-xs">
        <CommandShortcut className="static">Esc to close</CommandShortcut>
      </div>
    </CommandDialog>
  );
}

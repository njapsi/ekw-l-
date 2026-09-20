'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronsLeft, ChevronsRight, Menu, MoreHorizontal, Search, X } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipTrigger, cn } from '@growth-agent/ui';
import { APP_NAV_GROUPS, MOBILE_PRIMARY_NAV, activeNavHref } from './nav';
import { CommandPalette } from './command-palette';
import { NotificationBell } from './notification-bell';
import { OrgSwitcher, type OrgOption } from './org-switcher';
import { ThemeToggle } from './theme-toggle';
import { UserMenu } from './user-menu';

export interface AppShellProps {
  user: { name: string | null; email: string; image: string | null; isPlatformStaff: boolean };
  organizations: OrgOption[];
  activeOrgId: string;
  children: React.ReactNode;
}

const SIDEBAR_COLLAPSE_KEY = 'growth-agent-sidebar-collapsed';

export function AppShell({ user, organizations, activeOrgId, children }: AppShellProps) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const activeHref = activeNavHref(pathname);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1');
    } catch {
      /* per-viewer convenience only */
    }
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* per-viewer convenience only */
      }
      return next;
    });
  }

  // `collapsed` is a desktop-only, persisted preference (icon rail vs. full
  // width). The mobile full-screen drawer has its own room for labels and no
  // "collapse" concept of its own, so it always renders expanded regardless
  // of what the desktop sidebar last saved — otherwise a collapsed desktop
  // preference would leak into the mobile menu as an icons-only, unlabeled
  // drawer.
  function renderNavGroups(iconOnly: boolean) {
    return (
      <nav className="flex flex-col gap-4 p-3" aria-label="Main">
        {APP_NAV_GROUPS.map((group) => (
          <div key={group.label ?? 'top'} className="flex flex-col gap-1">
            {group.label && !iconOnly ? (
              <p className="text-muted-foreground px-3 pb-1 text-xs font-medium uppercase tracking-wide">
                {group.label}
              </p>
            ) : null}
            {group.items.map((item) => {
              const active = item.href === activeHref;
              const Icon = item.icon;
              const link = (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setMobileOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                    iconOnly && 'justify-center px-2',
                    active
                      ? 'bg-accent text-accent-foreground font-medium'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {iconOnly ? <span className="sr-only">{item.label}</span> : item.label}
                </Link>
              );
              if (!iconOnly) return link;
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
        {user.isPlatformStaff ? (
          <Link
            href="/admin"
            onClick={() => setMobileOpen(false)}
            className={cn(
              'text-muted-foreground hover:bg-muted hover:text-foreground mt-2 flex items-center gap-3 rounded-md px-3 py-2 text-sm',
              iconOnly && 'justify-center px-2',
            )}
          >
            {iconOnly ? <span className="sr-only">Admin</span> : 'Admin'}
          </Link>
        ) : null}
      </nav>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <a
        href="#main-content"
        className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <header className="border-border bg-background sticky top-0 z-40 flex h-14 items-center gap-3 border-b px-4">
        <Button
          variant="ghost"
          size="icon"
          className="lg:hidden"
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen((v) => !v)}
        >
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
        <Link href="/app/dashboard" className="flex items-center gap-2 font-semibold">
          <span className="bg-primary inline-block size-5 rounded" aria-hidden />
          <span className="hidden sm:inline">Growth Agent</span>
        </Link>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          className="border-input bg-background text-muted-foreground hover:bg-muted ml-4 hidden max-w-xs flex-1 items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors md:flex"
        >
          <Search className="size-3.5" aria-hidden />
          <span className="flex-1 text-left">Search or jump to...</span>
          <kbd className="bg-muted rounded border px-1.5 py-0.5 text-[10px] font-medium">⌘K</kbd>
        </button>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Search"
            onClick={() => setPaletteOpen(true)}
          >
            <Search className="size-4" />
          </Button>
          <ThemeToggle />
          <NotificationBell />
          <OrgSwitcher organizations={organizations} activeOrgId={activeOrgId} />
          <UserMenu name={user.name} email={user.email} image={user.image} />
        </div>
      </header>

      <div className="flex flex-1">
        <aside
          className={cn(
            'border-border hidden shrink-0 flex-col border-r transition-[width] lg:flex',
            collapsed ? 'w-16' : 'w-60',
          )}
        >
          <div className="flex-1 overflow-y-auto">{renderNavGroups(collapsed)}</div>
          <div className="border-border border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-center gap-2"
              onClick={toggleCollapsed}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <ChevronsRight className="size-4" aria-hidden />
              ) : (
                <>
                  <ChevronsLeft className="size-4" aria-hidden /> Collapse
                </>
              )}
            </Button>
          </div>
        </aside>

        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setMobileOpen(false)}
              aria-hidden
            />
            <div className="border-border bg-background absolute left-0 top-0 h-full w-64 overflow-y-auto border-r">
              <div className="flex h-14 items-center justify-between px-4">
                <span className="font-semibold">Menu</span>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Close navigation"
                >
                  <X className="size-5" />
                </Button>
              </div>
              {renderNavGroups(false)}
            </div>
          </div>
        ) : null}

        {/* Keyed by org: switching organizations remounts every client
            component, so no client-side state from the previous org survives. */}
        <main
          key={activeOrgId}
          id="main-content"
          className="min-w-0 flex-1 px-4 py-6 pb-20 sm:px-6 lg:px-8 lg:pb-6"
        >
          <div className="mx-auto max-w-5xl space-y-6">{children}</div>
        </main>
      </div>

      <MobileBottomNav activeHref={activeHref} onMore={() => setMobileOpen(true)} />

      <CommandPalette
        organizations={organizations}
        activeOrgId={activeOrgId}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
      />
    </div>
  );
}

function MobileBottomNav({
  activeHref,
  onMore,
}: {
  activeHref: string | null;
  onMore: () => void;
}) {
  return (
    <nav
      aria-label="Primary"
      className="border-border bg-background fixed inset-x-0 bottom-0 z-30 flex border-t lg:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {MOBILE_PRIMARY_NAV.map((item) => {
        const active = item.href === activeHref;
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]',
              active ? 'text-primary' : 'text-muted-foreground',
            )}
          >
            <Icon className="size-5" aria-hidden />
            {item.label}
          </Link>
        );
      })}
      <button
        type="button"
        onClick={onMore}
        className="text-muted-foreground flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]"
      >
        <MoreHorizontal className="size-5" aria-hidden />
        More
      </button>
    </nav>
  );
}

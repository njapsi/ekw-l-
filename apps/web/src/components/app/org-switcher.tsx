'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@growth-agent/ui';
import { switchOrgAction } from '@/server/org-actions';

export interface OrgOption {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export function OrgSwitcher({
  organizations,
  activeOrgId,
}: {
  organizations: OrgOption[];
  activeOrgId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active = organizations.find((o) => o.id === activeOrgId);

  function select(id: string) {
    if (id === activeOrgId) return;
    startTransition(async () => {
      const res = await switchOrgAction(id);
      if (!res.ok) return;
      // Land on the dashboard rather than staying on a page (a conversation, a
      // report) that belongs to the previous organization, then refresh so
      // every server component re-reads with the new org.
      router.push('/app/dashboard');
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-[12rem] justify-between gap-2"
          disabled={pending}
        >
          <span className="truncate">{active?.name ?? 'Select organization'}</span>
          <ChevronsUpDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        {organizations.map((o) => (
          <DropdownMenuItem key={o.id} onSelect={() => select(o.id)}>
            <span className="flex-1 truncate">{o.name}</span>
            <span className="text-muted-foreground text-xs">{o.role.toLowerCase()}</span>
            {o.id === activeOrgId ? <Check className="size-3.5" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => router.push('/onboarding?new=1')}>
          Create organization
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

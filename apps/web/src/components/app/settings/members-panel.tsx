'use client';

import { useState } from 'react';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@growth-agent/ui';
import {
  changeRoleAction,
  inviteMemberAction,
  removeMemberAction,
  resendInvitationAction,
  revokeInvitationAction,
  transferOwnershipAction,
} from '@/server/settings-actions';
import { ActionOutcome, formatWhen, relativeTime, useAction } from './shared';

type RoleName = 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER' | 'VIEWER';

export interface MembersData {
  selfId: string;
  selfRole: RoleName;
  /** Roles the current user may assign to others (server-computed). */
  assignableRoles: RoleName[];
  invitableRoles: RoleName[];
  canManageRoles: boolean;
  canRemove: boolean;
  canTransfer: boolean;
  members: Array<{
    userId: string;
    name: string | null;
    email: string;
    role: RoleName;
    joinedAt: string;
    lastActiveAt: string | null;
  }>;
  invitations: Array<{
    id: string;
    email: string;
    role: RoleName;
    expiresAt: string;
    expired: boolean;
    sendCount: number;
    invitedBy: string;
  }>;
}

const label = (r: string) => r.charAt(0) + r.slice(1).toLowerCase();

export function MembersPanel({ data }: { data: MembersData }) {
  return (
    <>
      {data.invitableRoles.length > 0 ? <InviteCard roles={data.invitableRoles} /> : null}
      {data.invitations.length > 0 ? (
        <InvitationsCard
          invitations={data.invitations}
          canManage={data.invitableRoles.length > 0}
        />
      ) : null}
      <MembersCard data={data} />
    </>
  );
}

function InviteCard({ roles }: { roles: RoleName[] }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleName>(
    roles.includes('MEMBER') ? 'MEMBER' : (roles[roles.length - 1] as RoleName),
  );
  const invite = useAction(inviteMemberAction);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Invite a member</CardTitle>
        <CardDescription>
          The invitation link works once, only for that email address, and expires in 7 days.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form
          className="flex flex-col gap-3 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void invite.run({ email, role: role as Exclude<RoleName, 'OWNER'> }).then((r) => {
              if (r.ok) setEmail('');
            });
          }}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="m-email">Email</Label>
            <Input
              id="m-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="m-role">Role</Label>
            <select
              id="m-role"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as RoleName)}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" disabled={invite.pending}>
            {invite.pending ? 'Inviting…' : 'Send invite'}
          </Button>
        </form>
        <ActionOutcome result={invite.result} />
        {invite.result?.ok && invite.result.inviteUrl && !invite.result.emailed ? (
          <Alert>
            <AlertDescription className="break-all">
              Invite link: <span className="font-mono text-xs">{invite.result.inviteUrl}</span>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function InvitationsCard({
  invitations,
  canManage,
}: {
  invitations: MembersData['invitations'];
  canManage: boolean;
}) {
  const resend = useAction(resendInvitationAction);
  const revoke = useAction(revokeInvitationAction);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Pending invitations</CardTitle>
      </CardHeader>
      <CardContent className="divide-border divide-y">
        {invitations.map((inv) => (
          <div key={inv.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{inv.email}</p>
              <p className="text-muted-foreground text-xs">
                {label(inv.role)} · invited by {inv.invitedBy} ·{' '}
                {inv.expired ? (
                  <span className="text-destructive">expired</span>
                ) : (
                  `expires ${formatWhen(inv.expiresAt)}`
                )}
              </p>
            </div>
            {canManage ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resend.pending}
                  onClick={() => void resend.run(inv.id)}
                >
                  Resend
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revoke.pending}
                  onClick={() => void revoke.run(inv.id)}
                >
                  Revoke
                </Button>
              </div>
            ) : null}
          </div>
        ))}
        <ActionOutcome result={resend.result ?? revoke.result} />
        {resend.result?.ok && resend.result.inviteUrl ? (
          <p className="text-muted-foreground break-all py-2 text-xs">
            New link: <span className="font-mono">{resend.result.inviteUrl}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MembersCard({ data }: { data: MembersData }) {
  const roleChange = useAction(changeRoleAction);
  const remove = useAction(removeMemberAction);
  const transfer = useAction(transferOwnershipAction);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Members ({data.members.length})</CardTitle>
      </CardHeader>
      <CardContent className="divide-border divide-y">
        {data.members.map((m) => {
          const self = m.userId === data.selfId;
          const canEditThis =
            data.canManageRoles &&
            !self &&
            (m.role !== 'OWNER' || data.selfRole === 'OWNER') &&
            data.assignableRoles.includes(m.role);
          return (
            <div key={m.userId} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {m.name ?? m.email}{' '}
                  {self ? <span className="text-muted-foreground">(you)</span> : null}
                </p>
                <p className="text-muted-foreground truncate text-xs">
                  {m.email} · joined {formatWhen(m.joinedAt)} · active{' '}
                  {relativeTime(m.lastActiveAt)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {canEditThis ? (
                  <select
                    aria-label={`Role for ${m.name ?? m.email}`}
                    className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                    defaultValue={m.role}
                    disabled={roleChange.pending}
                    onChange={(e) =>
                      void roleChange.run({
                        targetUserId: m.userId,
                        role: e.target.value as RoleName,
                      })
                    }
                  >
                    {data.assignableRoles.map((r) => (
                      <option key={r} value={r}>
                        {label(r)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Badge variant="outline">{label(m.role)}</Badge>
                )}
                {data.canTransfer && !self && m.role !== 'OWNER' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={transfer.pending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Make ${m.name ?? m.email} the owner? You will become an admin.`,
                        )
                      ) {
                        void transfer.run(m.userId);
                      }
                    }}
                  >
                    Make owner
                  </Button>
                ) : null}
                {(data.canRemove && !self && (m.role !== 'OWNER' || data.selfRole === 'OWNER')) ||
                self ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.pending}
                    onClick={() => {
                      const msg = self
                        ? 'Leave this organization? You will lose access immediately.'
                        : `Remove ${m.name ?? m.email} from this organization?`;
                      if (window.confirm(msg)) void remove.run(m.userId);
                    }}
                  >
                    {self ? 'Leave' : 'Remove'}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
        <div className="pt-2">
          <ActionOutcome result={roleChange.result ?? remove.result ?? transfer.result} />
        </div>
      </CardContent>
    </Card>
  );
}

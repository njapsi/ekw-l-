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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@growth-agent/ui';
import {
  cancelAccountDeletionAction,
  cancelOrgDeletionAction,
  changeRoleAction,
  inviteMemberAction,
  renameOrgAction,
  requestAccountDeletionAction,
  requestOrgDeletionAction,
  updateProfileAction,
} from '@/server/settings-actions';

export interface SettingsData {
  profile: { name: string | null; email: string; timezone: string };
  org: { id: string; name: string; slug: string; role: string };
  canManageMembers: boolean;
  canRenameOrg: boolean;
  canDeleteOrg: boolean;
  canExportData: boolean;
  orgDeletionScheduledAt: string | null;
  accountDeletionScheduledAt: string | null;
  members: Array<{
    userId: string;
    name: string | null;
    email: string;
    role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';
  }>;
}

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;

export function SettingsTabs({ data }: { data: SettingsData }) {
  return (
    <Tabs defaultValue="profile">
      <TabsList>
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="organization">Organization</TabsTrigger>
        <TabsTrigger value="members">Members</TabsTrigger>
        <TabsTrigger value="danger">Danger zone</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <ProfileForm profile={data.profile} />
      </TabsContent>
      <TabsContent value="organization">
        <OrgPanel org={data.org} canRename={data.canRenameOrg} />
      </TabsContent>
      <TabsContent value="members">
        <MembersPanel
          members={data.members}
          canManage={data.canManageMembers}
          selfEmail={data.profile.email}
        />
      </TabsContent>
      <TabsContent value="danger">
        <DangerZone data={data} />
      </TabsContent>
    </Tabs>
  );
}

function useAction<T>(fn: (input: T) => Promise<{ ok: boolean; error?: string }>) {
  const [state, setState] = useState<{ pending: boolean; error?: string; done?: boolean }>({
    pending: false,
  });
  async function run(input: T) {
    setState({ pending: true });
    const res = await fn(input);
    setState({ pending: false, error: res.error, done: res.ok });
    return res;
  }
  return { ...state, run };
}

function ProfileForm({ profile }: { profile: SettingsData['profile'] }) {
  const [name, setName] = useState(profile.name ?? '');
  const [timezone, setTimezone] = useState(profile.timezone);
  const action = useAction(updateProfileAction);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your profile</CardTitle>
        <CardDescription>Update how your name appears across the app.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run({ name, timezone });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="p-email">Email</Label>
            <Input id="p-email" value={profile.email} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-name">Name</Label>
            <Input id="p-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-tz">Timezone</Label>
            <Input
              id="p-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="UTC"
            />
          </div>
          {action.error ? (
            <p role="alert" className="text-destructive text-sm">
              {action.error}
            </p>
          ) : null}
          {action.done ? (
            <p role="status" className="text-muted-foreground text-sm">
              Saved.
            </p>
          ) : null}
          <Button type="submit" disabled={action.pending}>
            {action.pending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function OrgPanel({ org, canRename }: { org: SettingsData['org']; canRename: boolean }) {
  const [name, setName] = useState(org.name);
  const action = useAction(renameOrgAction);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organization</CardTitle>
        <CardDescription>
          <span className="font-mono text-xs">{org.slug}</span> · your role:{' '}
          {org.role.toLowerCase()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run({ name });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="o-name">Name</Label>
            <Input
              id="o-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canRename}
            />
          </div>
          {!canRename ? (
            <p className="text-muted-foreground text-sm">
              Only owners and admins can rename the organization.
            </p>
          ) : null}
          {action.error ? (
            <p role="alert" className="text-destructive text-sm">
              {action.error}
            </p>
          ) : null}
          {action.done ? (
            <p role="status" className="text-muted-foreground text-sm">
              Saved.
            </p>
          ) : null}
          <Button type="submit" disabled={!canRename || action.pending}>
            {action.pending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function DangerZone({ data }: { data: SettingsData }) {
  const [orgConfirm, setOrgConfirm] = useState('');
  const [acctConfirm, setAcctConfirm] = useState('');
  const orgDel = useAction(requestOrgDeletionAction);
  const orgCancel = useAction<void>(cancelOrgDeletionAction);
  const acctDel = useAction(requestAccountDeletionAction);
  const acctCancel = useAction<void>(cancelAccountDeletionAction);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export organization data</CardTitle>
          <CardDescription>
            Download every record this organization owns as a single JSON file (portability / DSR).
            Encrypted OAuth tokens are never included.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.canExportData ? (
            <Button asChild variant="outline">
              <a href="/app/settings/export">Download JSON export</a>
            </Button>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only owners and admins can export organization data.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive text-base">Delete this organization</CardTitle>
          <CardDescription>
            Every crawl, report, connection, conversation and automation for{' '}
            <span className="font-medium">{data.org.name}</span> is permanently deleted after a
            grace period. An owner can cancel before then.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.orgDeletionScheduledAt ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  Scheduled for permanent deletion on{' '}
                  {new Date(data.orgDeletionScheduledAt).toLocaleString()}.
                </span>
                {data.canDeleteOrg ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    disabled={orgCancel.pending}
                    onClick={() => void orgCancel.run()}
                  >
                    {orgCancel.pending ? 'Cancelling…' : 'Cancel deletion'}
                  </Button>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : data.canDeleteOrg ? (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void orgDel.run({ confirm: orgConfirm });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="dz-org">
                  Type <span className="font-mono">{data.org.name}</span> to confirm
                </Label>
                <Input
                  id="dz-org"
                  value={orgConfirm}
                  onChange={(e) => setOrgConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {orgDel.error ? (
                <p role="alert" className="text-destructive text-sm">
                  {orgDel.error}
                </p>
              ) : null}
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  orgDel.pending ||
                  orgConfirm.trim().toLowerCase() !== data.org.name.trim().toLowerCase()
                }
              >
                {orgDel.pending ? 'Scheduling…' : 'Schedule deletion'}
              </Button>
            </form>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only an owner can delete the organization.
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive text-base">Delete my account</CardTitle>
          <CardDescription>
            You are signed out of every device immediately. Organizations where you are the only
            owner are scheduled for deletion too. After the grace period your account is anonymised.
            Sign back in before then to cancel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.accountDeletionScheduledAt ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  Your account is scheduled for deletion on{' '}
                  {new Date(data.accountDeletionScheduledAt).toLocaleString()}.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={acctCancel.pending}
                  onClick={() => void acctCancel.run()}
                >
                  {acctCancel.pending ? 'Cancelling…' : 'Keep my account'}
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void acctDel.run({ confirm: acctConfirm });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="dz-acct">
                  Type <span className="font-mono">DELETE</span> to confirm
                </Label>
                <Input
                  id="dz-acct"
                  value={acctConfirm}
                  onChange={(e) => setAcctConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
              {acctDel.error ? (
                <p role="alert" className="text-destructive text-sm">
                  {acctDel.error}
                </p>
              ) : null}
              {acctDel.done ? (
                <p className="text-muted-foreground text-sm">
                  Scheduled. You will be signed out now.
                </p>
              ) : null}
              <Button
                type="submit"
                variant="destructive"
                disabled={acctDel.pending || acctConfirm.trim().toUpperCase() !== 'DELETE'}
              >
                {acctDel.pending ? 'Scheduling…' : 'Delete my account'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MembersPanel({
  members,
  canManage,
  selfEmail,
}: {
  members: SettingsData['members'];
  canManage: boolean;
  selfEmail: string;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'ADMIN' | 'MEMBER' | 'VIEWER'>('MEMBER');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const invite = useAction(inviteMemberAction);
  const roleChange = useAction(changeRoleAction);

  return (
    <div className="space-y-4">
      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invite a member</CardTitle>
            <CardDescription>
              Phase 2 has no invitation email yet — copy the generated link and share it directly.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={async (e) => {
                e.preventDefault();
                const res = (await invite.run({ email, role })) as { inviteUrl?: string };
                if (res.inviteUrl) setInviteUrl(res.inviteUrl);
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
                  onChange={(e) => setRole(e.target.value as typeof role)}
                >
                  <option value="ADMIN">Admin</option>
                  <option value="MEMBER">Member</option>
                  <option value="VIEWER">Viewer</option>
                </select>
              </div>
              <Button type="submit" disabled={invite.pending}>
                {invite.pending ? 'Creating…' : 'Create invite'}
              </Button>
            </form>
            {invite.error ? (
              <p role="alert" className="text-destructive mt-2 text-sm">
                {invite.error}
              </p>
            ) : null}
            {inviteUrl ? (
              <Alert className="mt-3">
                <AlertDescription className="break-all">
                  Invite link: <span className="font-mono text-xs">{inviteUrl}</span>
                </AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
        </CardHeader>
        <CardContent className="divide-border divide-y">
          {members.map((m) => (
            <div key={m.userId} className="flex items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{m.name ?? m.email}</p>
                <p className="text-muted-foreground truncate text-xs">{m.email}</p>
              </div>
              {canManage && m.email !== selfEmail ? (
                <select
                  aria-label={`Change role for ${m.name ?? m.email}`}
                  className="border-input bg-background h-8 rounded-md border px-2 text-xs"
                  defaultValue={m.role}
                  disabled={roleChange.pending}
                  onChange={(e) =>
                    void roleChange.run({
                      targetUserId: m.userId,
                      role: e.target.value as (typeof ROLES)[number],
                    })
                  }
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r.toLowerCase()}
                    </option>
                  ))}
                </select>
              ) : (
                <Badge variant="outline">{m.role.toLowerCase()}</Badge>
              )}
            </div>
          ))}
          {roleChange.error ? (
            <p role="alert" className="text-destructive py-2 text-sm">
              {roleChange.error}
            </p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

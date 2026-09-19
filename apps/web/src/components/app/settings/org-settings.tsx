'use client';

import { useState } from 'react';
import {
  Alert,
  AlertDescription,
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
  cancelOrgDeletionAction,
  requestOrgDeletionAction,
  updateOrgAction,
} from '@/server/settings-actions';
import { ActionOutcome, formatWhen, useAction } from './shared';

export interface OrgSettingsData {
  name: string;
  slug: string;
  timezone: string;
  defaultLocale: string;
  role: string;
  canUpdate: boolean;
}

export function OrgSettingsForm({ org }: { org: OrgSettingsData }) {
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [timezone, setTimezone] = useState(org.timezone);
  const [defaultLocale, setDefaultLocale] = useState(org.defaultLocale);
  const action = useAction(updateOrgAction);
  const disabled = !org.canUpdate;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organization details</CardTitle>
        <CardDescription>Your role here: {org.role.toLowerCase()}.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-md space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run({ name, slug, timezone, defaultLocale });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="o-name">Name</Label>
            <Input
              id="o-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="o-slug">Slug</Label>
            <Input
              id="o-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={disabled}
              className="font-mono"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="o-tz">Time zone</Label>
              <Input
                id="o-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                disabled={disabled}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-locale">Default language</Label>
              <Input
                id="o-locale"
                value={defaultLocale}
                onChange={(e) => setDefaultLocale(e.target.value)}
                disabled={disabled}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Logo</Label>
            <p className="text-muted-foreground text-xs">
              Logo upload is not available yet: it needs object storage, which this deployment does
              not have.
            </p>
          </div>
          {disabled ? (
            <p className="text-muted-foreground text-sm">
              Only owners and admins can change these settings.
            </p>
          ) : null}
          <ActionOutcome result={action.result} />
          <Button type="submit" disabled={disabled || action.pending}>
            {action.pending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export function OrgDangerZone({
  orgName,
  canDelete,
  canExport,
  deletionScheduledAt,
}: {
  orgName: string;
  canDelete: boolean;
  canExport: boolean;
  deletionScheduledAt: string | null;
}) {
  const [confirm, setConfirm] = useState('');
  const del = useAction(requestOrgDeletionAction);
  const cancel = useAction(cancelOrgDeletionAction);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export organization data</CardTitle>
          <CardDescription>
            Every record this organization owns, as one JSON file. Encrypted credentials are never
            included.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canExport ? (
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
            When you schedule deletion, automations and scheduled syncs stop immediately, pending
            approvals are cancelled, and a paid plan is set to end at the close of its billing
            period. After the grace period, access at YouTube, TikTok, Google and WordPress is
            revoked and all data is permanently deleted. An owner can cancel before then.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {deletionScheduledAt ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col gap-2">
                <span>Scheduled for permanent deletion on {formatWhen(deletionScheduledAt)}.</span>
                {canDelete ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit"
                    disabled={cancel.pending}
                    onClick={() => void cancel.run(undefined)}
                  >
                    {cancel.pending ? 'Cancelling…' : 'Cancel deletion'}
                  </Button>
                ) : null}
                <ActionOutcome result={cancel.result} />
              </AlertDescription>
            </Alert>
          ) : canDelete ? (
            <form
              className="max-w-md space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void del.run({ confirm });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="dz-org">
                  Type <span className="font-mono">{orgName}</span> to confirm
                </Label>
                <Input
                  id="dz-org"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <ActionOutcome result={del.result} />
              <Button
                type="submit"
                variant="destructive"
                disabled={
                  del.pending || confirm.trim().toLowerCase() !== orgName.trim().toLowerCase()
                }
              >
                {del.pending ? 'Scheduling…' : 'Schedule deletion'}
              </Button>
            </form>
          ) : (
            <p className="text-muted-foreground text-sm">
              Only an owner can delete the organization.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

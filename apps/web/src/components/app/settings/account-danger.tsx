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
  cancelAccountDeletionAction,
  deactivateAccountAction,
  requestAccountDeletionAction,
} from '@/server/settings-actions';
import { ActionOutcome, formatWhen, useAction } from './shared';

export function AccountDataAndDeletion({
  deletionScheduledAt,
  soleOwnerOf,
}: {
  deletionScheduledAt: string | null;
  soleOwnerOf: string[];
}) {
  const [confirm, setConfirm] = useState('');
  const del = useAction(requestAccountDeletionAction);
  const cancel = useAction(cancelAccountDeletionAction);
  const deactivate = useAction(deactivateAccountAction);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Export my data</CardTitle>
          <CardDescription>
            Your profile, memberships, sessions, security events, notifications and the actions you
            performed, as JSON. It never contains other members&apos; data or any
            organization&apos;s business data — use the organization export for that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline">
            <a href="/app/settings/account/export">Download my data</a>
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Deactivate my account</CardTitle>
          <CardDescription>
            Signs you out everywhere and pauses the automations you own. Nothing is deleted. Sign in
            again any time to reactivate; paused automations stay paused until you resume them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ActionOutcome result={deactivate.result} />
          {deactivate.result?.ok ? null : (
            <Button
              variant="outline"
              disabled={deactivate.pending}
              onClick={() => {
                if (window.confirm('Deactivate your account and sign out everywhere?'))
                  void deactivate.run(undefined);
              }}
            >
              {deactivate.pending ? 'Deactivating…' : 'Deactivate account'}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive text-base">Delete my account</CardTitle>
          <CardDescription>
            You are signed out of every device immediately. After the grace period your account is
            anonymised. Sign back in before then to cancel.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {soleOwnerOf.length > 0 && !deletionScheduledAt ? (
            <Alert variant="destructive">
              <AlertDescription>
                You are the only owner of {soleOwnerOf.join(', ')}. Deleting your account also
                schedules {soleOwnerOf.length === 1 ? 'that organization' : 'those organizations'}{' '}
                for deletion. Transfer ownership first if others should keep{' '}
                {soleOwnerOf.length === 1 ? 'it' : 'them'}.
              </AlertDescription>
            </Alert>
          ) : null}
          {deletionScheduledAt ? (
            <Alert variant="destructive">
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  Your account is scheduled for deletion on {formatWhen(deletionScheduledAt)}.
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  disabled={cancel.pending}
                  onClick={() => void cancel.run(undefined)}
                >
                  {cancel.pending ? 'Cancelling…' : 'Keep my account'}
                </Button>
                <ActionOutcome result={cancel.result} />
              </AlertDescription>
            </Alert>
          ) : (
            <form
              className="max-w-md space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void del.run({ confirm });
              }}
            >
              <div className="space-y-1.5">
                <Label htmlFor="dz-acct">
                  Type <span className="font-mono">DELETE</span> to confirm
                </Label>
                <Input
                  id="dz-acct"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <ActionOutcome result={del.result} />
              {del.result?.ok ? (
                <p className="text-muted-foreground text-sm">
                  Scheduled. You will be signed out now.
                </p>
              ) : null}
              <Button
                type="submit"
                variant="destructive"
                disabled={del.pending || confirm.trim().toUpperCase() !== 'DELETE'}
              >
                {del.pending ? 'Scheduling…' : 'Delete my account'}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </>
  );
}

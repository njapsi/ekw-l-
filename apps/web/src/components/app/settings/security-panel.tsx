'use client';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@growth-agent/ui';
import { revokeOtherSessionsAction, revokeSessionAction } from '@/server/settings-actions';
import { ActionOutcome, formatWhen, relativeTime, useAction } from './shared';

export interface SessionView {
  handle: string;
  current: boolean;
  device: string;
  authMethod: string;
  network: string | null;
  createdAt: string;
  lastActiveAt: string;
}

const METHOD: Record<string, string> = {
  password: 'Password',
  'magic-link': 'Email link',
  google: 'Google',
  dev: 'Dev login',
  unknown: 'Unknown',
};

export function SessionsCard({ sessions }: { sessions: SessionView[] }) {
  const revokeOne = useAction(revokeSessionAction);
  const revokeOthers = useAction(revokeOtherSessionsAction);
  const others = sessions.filter((s) => !s.current).length;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Active sessions</CardTitle>
          <CardDescription>
            Signing a session out ends it on the server — the device is refused on its next request.
            Location is shown as a network range only; we do not store full IP addresses.
          </CardDescription>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={revokeOthers.pending}
          onClick={() => {
            if (window.confirm('Sign out every other device and browser?'))
              void revokeOthers.run(undefined);
          }}
        >
          {revokeOthers.pending ? 'Signing out…' : 'Sign out all other sessions'}
        </Button>
      </CardHeader>
      <CardContent className="divide-border divide-y">
        {sessions.length === 0 ? (
          <p className="text-muted-foreground py-2 text-sm">
            No tracked sessions yet. Sessions started before session tracking was enabled are not
            listed; &quot;Sign out all other sessions&quot; still ends them.
          </p>
        ) : null}
        {sessions.map((s) => (
          <div key={s.handle} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                {s.device}
                {s.current ? <Badge variant="success">This device</Badge> : null}
              </p>
              <p className="text-muted-foreground text-xs">
                {METHOD[s.authMethod] ?? s.authMethod} · {s.network ?? 'network unknown'} · signed
                in {formatWhen(s.createdAt)} · last active {relativeTime(s.lastActiveAt)}
              </p>
            </div>
            {!s.current ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={revokeOne.pending}
                onClick={() => void revokeOne.run(s.handle)}
              >
                Sign out
              </Button>
            ) : null}
          </div>
        ))}
        <div className="pt-2">
          <ActionOutcome result={revokeOne.result ?? revokeOthers.result} />
          {others === 0 && sessions.length > 0 ? (
            <p className="text-muted-foreground text-xs">No other active sessions.</p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

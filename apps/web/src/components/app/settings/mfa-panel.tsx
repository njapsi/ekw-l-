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
  confirmMfaEnrollmentAction,
  disableMfaAction,
  regenerateRecoveryCodesAction,
  startMfaEnrollmentAction,
} from '@/server/settings-actions';
import { ActionOutcome, formatWhen, useAction } from './shared';

export interface MfaStatusView {
  enabled: boolean;
  enrolledAt: string | null;
  recoveryCodesRemaining: number;
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Alert>
      <AlertDescription className="space-y-2">
        <p className="font-medium">
          Save these 10 recovery codes — each works once, and this is the only time they&apos;re
          shown.
        </p>
        <div className="bg-muted grid grid-cols-2 gap-1 rounded p-2 font-mono text-xs sm:grid-cols-3">
          {codes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </div>
        <p className="text-xs">
          Use one if you lose access to your authenticator app. Store them somewhere safe — a
          password manager, not a screenshot on the same device.
        </p>
      </AlertDescription>
    </Alert>
  );
}

function EnrollFlow({ onDone }: { onDone: () => void }) {
  const start = useAction(startMfaEnrollmentAction);
  const confirm = useAction(confirmMfaEnrollmentAction);
  const [code, setCode] = useState('');

  if (confirm.result?.ok && confirm.result.recoveryCodes) {
    return (
      <div className="space-y-3">
        <RecoveryCodes codes={confirm.result.recoveryCodes} />
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  if (!start.result?.ok) {
    return (
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">
          You&apos;ll need an authenticator app — Google Authenticator, Authy, 1Password, or
          similar.
        </p>
        <Button size="sm" disabled={start.pending} onClick={() => void start.run(undefined)}>
          {start.pending ? 'Generating…' : 'Set up authenticator app'}
        </Button>
        <ActionOutcome result={start.result} />
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (start.result?.factorId) {
          void confirm.run({ factorId: start.result.factorId, code });
        }
      }}
    >
      <div className="space-y-2">
        <p className="text-sm">
          Scan this into your authenticator app, or enter the key manually:
        </p>
        <code className="bg-muted block break-all rounded p-2 font-mono text-xs">
          {start.result.secret}
        </code>
        <p className="text-muted-foreground text-xs break-all">{start.result.otpauthUri}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mfa-code">Enter the 6-digit code it shows</Label>
        <Input
          id="mfa-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          placeholder="123456"
          required
        />
      </div>
      <Button type="submit" size="sm" disabled={confirm.pending || code.length !== 6}>
        {confirm.pending ? 'Verifying…' : 'Turn on two-factor authentication'}
      </Button>
      <ActionOutcome result={confirm.result} />
    </form>
  );
}

function DisableFlow({ onDone }: { onDone: () => void }) {
  const disable = useAction(disableMfaAction);
  const [code, setCode] = useState('');

  if (disable.result?.ok) {
    return (
      <div className="space-y-3">
        <ActionOutcome result={disable.result} />
        <Button size="sm" onClick={onDone}>
          Close
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void disable.run({ code });
      }}
    >
      <p className="text-muted-foreground text-sm">
        Enter a current code from your authenticator app (or a recovery code) to confirm.
      </p>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="123456 or XXXX-XXXX"
        required
      />
      <Button type="submit" size="sm" variant="destructive" disabled={disable.pending || !code}>
        {disable.pending ? 'Turning off…' : 'Turn off two-factor authentication'}
      </Button>
      <ActionOutcome result={disable.result} />
    </form>
  );
}

function RegenerateFlow({ onDone }: { onDone: () => void }) {
  const regen = useAction(regenerateRecoveryCodesAction);
  const [code, setCode] = useState('');

  if (regen.result?.ok && regen.result.recoveryCodes) {
    return (
      <div className="space-y-3">
        <RecoveryCodes codes={regen.result.recoveryCodes} />
        <Button size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void regen.run({ code });
      }}
    >
      <p className="text-muted-foreground text-sm">
        Enter a current authenticator code to generate a fresh set of recovery codes. The old ones
        stop working immediately.
      </p>
      <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" required />
      <Button type="submit" size="sm" variant="outline" disabled={regen.pending || !code}>
        {regen.pending ? 'Generating…' : 'Generate new recovery codes'}
      </Button>
      <ActionOutcome result={regen.result} />
    </form>
  );
}

type Panel = 'none' | 'enroll' | 'disable' | 'regenerate';

export function MfaCard({ status }: { status: MfaStatusView }) {
  const [panel, setPanel] = useState<Panel>('none');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Authenticator app (TOTP)</CardTitle>
        <CardDescription>
          A time-based one-time code from an app on your phone, required alongside your password
          or email link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 text-sm font-medium">
              Status
              <Badge variant={status.enabled ? 'success' : 'outline'}>
                {status.enabled ? 'On' : 'Off'}
              </Badge>
            </p>
            {status.enabled ? (
              <p className="text-muted-foreground text-xs">
                Enabled {formatWhen(status.enrolledAt)} · {status.recoveryCodesRemaining} recovery
                code{status.recoveryCodesRemaining === 1 ? '' : 's'} remaining
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                Not on. Your account currently relies on your password or email link only.
              </p>
            )}
          </div>
          {panel === 'none' ? (
            <div className="flex gap-2">
              {status.enabled ? (
                <>
                  <Button size="sm" variant="outline" onClick={() => setPanel('regenerate')}>
                    New recovery codes
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setPanel('disable')}>
                    Turn off
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={() => setPanel('enroll')}>
                  Turn on
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {panel === 'enroll' ? <EnrollFlow onDone={() => setPanel('none')} /> : null}
        {panel === 'disable' ? <DisableFlow onDone={() => setPanel('none')} /> : null}
        {panel === 'regenerate' ? <RegenerateFlow onDone={() => setPanel('none')} /> : null}
      </CardContent>
    </Card>
  );
}

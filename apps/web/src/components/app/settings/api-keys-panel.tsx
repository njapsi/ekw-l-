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
import { createApiKeyAction, revokeApiKeyAction } from '@/server/settings-actions';
import { ActionOutcome, formatWhen, relativeTime, useAction } from './shared';

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export function ApiKeysPanel({
  keys,
  grantableScopes,
  canCreate,
  canRevoke,
}: {
  keys: ApiKeyRow[];
  grantableScopes: string[];
  canCreate: boolean;
  canRevoke: boolean;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [expires, setExpires] = useState('90');
  const create = useAction(createApiKeyAction);
  const revoke = useAction(revokeApiKeyAction);
  const now = Date.now();

  return (
    <>
      {canCreate ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create an API key</CardTitle>
            <CardDescription>
              Keys act for this organization with only the scopes you pick — never more than your
              own role allows — and stop working if you lose that access.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void create
                  .run({
                    name,
                    scopes,
                    expiresInDays: expires === 'never' ? null : Number(expires),
                  })
                  .then((r) => {
                    if (r.ok) {
                      setName('');
                      setScopes([]);
                    }
                  });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="k-name">Name</Label>
                  <Input
                    id="k-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Reporting script"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="k-exp">Expires</Label>
                  <select
                    id="k-exp"
                    className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                    value={expires}
                    onChange={(e) => setExpires(e.target.value)}
                  >
                    <option value="30">In 30 days</option>
                    <option value="90">In 90 days</option>
                    <option value="365">In 1 year</option>
                    <option value="never">Never</option>
                  </select>
                </div>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Scopes</legend>
                <div className="grid gap-2 sm:grid-cols-3">
                  {grantableScopes.map((s) => (
                    <label key={s} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={scopes.includes(s)}
                        onChange={(e) =>
                          setScopes((cur) =>
                            e.target.checked ? [...cur, s] : cur.filter((x) => x !== s),
                          )
                        }
                      />
                      <span className="font-mono text-xs">{s}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Button
                type="submit"
                disabled={create.pending || scopes.length === 0 || !name.trim()}
              >
                {create.pending ? 'Creating…' : 'Create key'}
              </Button>
            </form>
            {create.result?.ok && create.result.key ? (
              <Alert>
                <AlertDescription className="space-y-2">
                  <p className="font-medium">Copy this key now — it will not be shown again.</p>
                  <code className="bg-muted block break-all rounded p-2 font-mono text-xs">
                    {create.result.key}
                  </code>
                  <p className="text-xs">
                    Send it as <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>{' '}
                    to <span className="font-mono">/api/v1/…</span>.
                  </p>
                </AlertDescription>
              </Alert>
            ) : (
              <ActionOutcome result={create.result} />
            )}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Keys</CardTitle>
          <CardDescription>
            Only a hash of each key is stored; the prefix identifies it.
          </CardDescription>
        </CardHeader>
        <CardContent className="divide-border divide-y">
          {keys.length === 0 ? (
            <p className="text-muted-foreground py-2 text-sm">No API keys yet.</p>
          ) : null}
          {keys.map((k) => {
            const expired = k.expiresAt ? new Date(k.expiresAt).getTime() <= now : false;
            const status = k.revokedAt ? 'Revoked' : expired ? 'Expired' : 'Active';
            return (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {k.name}
                    <Badge variant={status === 'Active' ? 'success' : 'outline'}>{status}</Badge>
                  </p>
                  <p className="text-muted-foreground font-mono text-xs">ga_{k.prefix}_…</p>
                  <p className="text-muted-foreground text-xs">
                    {k.scopes.join(', ')} · created {formatWhen(k.createdAt)} · last used{' '}
                    {relativeTime(k.lastUsedAt)}
                    {k.expiresAt ? ` · expires ${formatWhen(k.expiresAt)}` : ' · no expiry'}
                  </p>
                </div>
                {canRevoke && status === 'Active' ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.pending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `Revoke "${k.name}"? Anything using it stops working immediately.`,
                        )
                      ) {
                        void revoke.run(k.id);
                      }
                    }}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            );
          })}
          <div className="pt-2">
            <ActionOutcome result={revoke.result} />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

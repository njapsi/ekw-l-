'use client';

import { useState } from 'react';
import { Button, Input, Label } from '@growth-agent/ui';
import {
  type ActionResult,
  addMcpServerAction,
  setMcpServerTrustLevelAction,
} from '@/server/mcp-actions';

function Outcome({ result }: { result: ActionResult | null }) {
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {result ? (
        <p className={result.ok ? 'text-muted-foreground' : 'text-destructive'}>
          {result.ok ? result.message : result.error}
        </p>
      ) : null}
    </div>
  );
}

const selectClass = 'border-input bg-background h-9 w-full rounded-md border px-3 text-sm';

export function AddMcpServerForm() {
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [authKind, setAuthKind] = useState<'NONE' | 'API_KEY' | 'BEARER_TOKEN'>('NONE');
  const [credential, setCredential] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function submit() {
    setPending(true);
    setResult(null);
    const r = await addMcpServerAction({
      name,
      endpoint,
      transport: 'SSE',
      authKind,
      credential: authKind === 'NONE' ? undefined : credential,
    });
    setResult(r);
    if (r.ok) {
      setName('');
      setEndpoint('');
      setCredential('');
    }
    setPending(false);
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          placeholder="Analytics Research"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mcp-endpoint">Endpoint (https, SSE)</Label>
        <Input
          id="mcp-endpoint"
          placeholder="https://mcp.example.com/sse"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          autoComplete="off"
          required
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="mcp-auth">Authentication</Label>
          <select
            id="mcp-auth"
            className={selectClass}
            value={authKind}
            onChange={(e) => setAuthKind(e.target.value as typeof authKind)}
          >
            <option value="NONE">None</option>
            <option value="BEARER_TOKEN">Bearer token</option>
            <option value="API_KEY">API key</option>
          </select>
        </div>
        {authKind !== 'NONE' ? (
          <div className="space-y-1.5">
            <Label htmlFor="mcp-credential">Credential</Label>
            <Input
              id="mcp-credential"
              type="password"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
        ) : null}
      </div>
      <p className="text-muted-foreground text-xs">
        The server is added disabled and untrusted (UNVERIFIED_EXTERNAL). Test the connection to
        discover its tools, then enable only the ones you want the agent to use.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? 'Adding…' : 'Add server'}
      </Button>
      <Outcome result={result} />
    </form>
  );
}

export function TrustLevelSelect({
  serverId,
  value,
}: {
  serverId: string;
  value: 'INTERNAL' | 'TRUSTED' | 'VERIFIED_EXTERNAL' | 'UNVERIFIED_EXTERNAL';
}) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);

  async function change(next: string) {
    setPending(true);
    setResult(await setMcpServerTrustLevelAction(serverId, next as never));
    setPending(false);
  }

  return (
    <div className="space-y-1">
      <select
        className={selectClass}
        value={value}
        disabled={pending}
        onChange={(e) => void change(e.target.value)}
      >
        <option value="UNVERIFIED_EXTERNAL">Unverified external</option>
        <option value="VERIFIED_EXTERNAL">Verified external</option>
        <option value="TRUSTED">Trusted</option>
        <option value="INTERNAL">Internal</option>
      </select>
      <div role="status" aria-live="polite" className="text-xs">
        {result && !result.ok ? <p className="text-destructive">{result.error}</p> : null}
      </div>
    </div>
  );
}

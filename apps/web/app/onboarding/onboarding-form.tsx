'use client';

import { useActionState } from 'react';
import { Button, Input, Label } from '@growth-agent/ui';
import { createOrgAction } from './actions';

export function OnboardingForm() {
  const [state, formAction, pending] = useActionState(createOrgAction, {});

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="name">Organization name</Label>
        <Input
          id="name"
          name="name"
          placeholder="Acme Media"
          required
          minLength={2}
          maxLength={80}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="type">Type</Label>
        <select
          id="type"
          name="type"
          defaultValue="TEAM"
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
        >
          <option value="PERSONAL">Just me</option>
          <option value="TEAM">Team</option>
          <option value="AGENCY">Agency</option>
          <option value="BUSINESS">Business</option>
        </select>
      </div>
      {state?.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? 'Creating…' : 'Create organization'}
      </Button>
    </form>
  );
}

'use client';

import { useState } from 'react';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@growth-agent/ui';
import { updateProfileAction } from '@/server/settings-actions';
import { ActionOutcome, useAction } from './shared';

export interface ProfileData {
  name: string | null;
  email: string;
  emailVerified: boolean;
  timezone: string;
  locale: string;
}

export function ProfileForm({ profile }: { profile: ProfileData }) {
  const [name, setName] = useState(profile.name ?? '');
  const [timezone, setTimezone] = useState(profile.timezone);
  const [locale, setLocale] = useState(profile.locale);
  const action = useAction(updateProfileAction);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your profile</CardTitle>
        <CardDescription>
          How you appear to your team, and how times are shown to you.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="max-w-md space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void action.run({ name, timezone, locale });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="p-email">Email</Label>
            <Input id="p-email" value={profile.email} disabled />
            <p className="text-muted-foreground text-xs">
              {profile.emailVerified
                ? 'Verified.'
                : 'Not verified yet — check your inbox for the verification link.'}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-name">Full name</Label>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="p-tz">Time zone</Label>
              <Input
                id="p-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/Chicago"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-locale">Language</Label>
              <Input
                id="p-locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value)}
                placeholder="en"
                maxLength={10}
              />
            </div>
          </div>
          <ActionOutcome result={action.result} />
          <Button type="submit" disabled={action.pending}>
            {action.pending ? 'Saving…' : 'Save changes'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

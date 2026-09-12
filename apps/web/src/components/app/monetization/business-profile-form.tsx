'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Textarea } from '@growth-agent/ui';
import { saveBusinessProfileAction } from '@/server/monetization-actions';

export interface BusinessProfileView {
  niche: string | null;
  audienceDescription: string | null;
  offerings: string[];
  goals: string[];
  emailListSize: number | null;
  hasWebsite: boolean;
  sellsProducts: boolean;
  doesSponsorships: boolean;
  doesAffiliates: boolean;
  doesConsulting: boolean;
  hasMembership: boolean;
  hasCourse: boolean;
  attestations: Partial<
    Record<'twoStep' | 'noStrikes' | 'adsenseLinked' | 'regionEligible', boolean>
  > | null;
  notes: string | null;
}

const ACTIVITY_FLAGS: Array<[keyof BusinessProfileView, string]> = [
  ['hasWebsite', 'I have a website'],
  ['sellsProducts', 'I sell products'],
  ['doesSponsorships', 'I do sponsorships'],
  ['doesAffiliates', 'I do affiliate marketing'],
  ['doesConsulting', 'I do consulting / coaching'],
  ['hasMembership', 'I run a membership / paid community'],
  ['hasCourse', 'I have a course'],
];

const ATTESTATIONS: Array<['twoStep' | 'noStrikes' | 'adsenseLinked' | 'regionEligible', string]> =
  [
    ['twoStep', '2-step verification is on for my Google account'],
    ['noStrikes', 'No active Community Guidelines strikes'],
    ['adsenseLinked', 'An AdSense account is linked (or ready to link)'],
    ['regionEligible', 'I am in a country/region where the Partner Program is available'],
  ];

export function BusinessProfileForm({ profile }: { profile: BusinessProfileView | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(!profile);
  const [niche, setNiche] = useState(profile?.niche ?? '');
  const [audience, setAudience] = useState(profile?.audienceDescription ?? '');
  const [offerings, setOfferings] = useState((profile?.offerings ?? []).join(', '));
  const [goals, setGoals] = useState((profile?.goals ?? []).join(', '));
  const [emailListSize, setEmailListSize] = useState(
    profile?.emailListSize != null ? String(profile.emailListSize) : '',
  );
  const [flags, setFlags] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const [key] of ACTIVITY_FLAGS) init[key as string] = Boolean(profile?.[key]);
    return init;
  });
  const [att, setAtt] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const [key] of ATTESTATIONS) init[key] = Boolean(profile?.attestations?.[key]);
    return init;
  });
  const [notes, setNotes] = useState(profile?.notes ?? '');
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = () =>
    start(async () => {
      setMsg(null);
      const r = await saveBusinessProfileAction({
        niche: niche.trim() || undefined,
        audienceDescription: audience.trim() || undefined,
        offerings: offerings.trim() || undefined,
        goals: goals.trim() || undefined,
        emailListSize: emailListSize.trim() || undefined,
        hasWebsite: flags.hasWebsite,
        sellsProducts: flags.sellsProducts,
        doesSponsorships: flags.doesSponsorships,
        doesAffiliates: flags.doesAffiliates,
        doesConsulting: flags.doesConsulting,
        hasMembership: flags.hasMembership,
        hasCourse: flags.hasCourse,
        twoStep: att.twoStep,
        noStrikes: att.noStrikes,
        adsenseLinked: att.adsenseLinked,
        regionEligible: att.regionEligible,
        notes: notes.trim() || undefined,
      });
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? 'Saved.') : (r.error ?? 'Failed') });
      if (r.ok) router.refresh();
    });

  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium">Business profile</h2>
          <p className="text-muted-foreground text-xs">
            Everything here is entered by you. It is used only to shape the opportunity list — no
            third-party data is inferred from it.
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : profile ? 'Edit' : 'Add'}
        </Button>
      </div>

      {open ? (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="niche">Niche / topic</Label>
              <Input id="niche" value={niche} onChange={(e) => setNiche(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="email">Email list size (optional)</Label>
              <Input
                id="email"
                inputMode="numeric"
                value={emailListSize}
                onChange={(e) => setEmailListSize(e.target.value.replace(/[^\d]/g, ''))}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="audience">Audience description</Label>
            <Textarea
              id="audience"
              rows={3}
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="offerings">Current offerings (comma-separated)</Label>
            <Input
              id="offerings"
              value={offerings}
              onChange={(e) => setOfferings(e.target.value)}
              placeholder="e.g. Lightroom presets, 1:1 coaching"
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="goals">Goals (comma-separated)</Label>
            <Input
              id="goals"
              value={goals}
              onChange={(e) => setGoals(e.target.value)}
              placeholder="e.g. replace my salary, launch a course"
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">What you already do</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {ACTIVITY_FLAGS.map(([key, label]) => (
                <label key={key as string} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={flags[key as string] ?? false}
                    onChange={(e) => setFlags((f) => ({ ...f, [key as string]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              YouTube Partner Program checklist (your attestation)
            </legend>
            <p className="text-muted-foreground text-xs">
              These are things the API cannot confirm. Ticking them does not make you eligible —
              YouTube decides that when you apply in YouTube Studio.
            </p>
            <div className="grid gap-2">
              {ATTESTATIONS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={att[key] ?? false}
                    onChange={(e) => setAtt((a) => ({ ...a, [key]: e.target.checked }))}
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Textarea
              id="notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : 'Save profile'}
            </Button>
            {msg ? (
              <span
                role={msg.ok ? 'status' : 'alert'}
                className={`text-sm ${msg.ok ? 'text-muted-foreground' : 'text-destructive'}`}
              >
                {msg.text}
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

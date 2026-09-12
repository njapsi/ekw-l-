'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@growth-agent/ui';
import {
  type MonetizationAttestations,
  setMonetizationAttestationsAction,
} from '@/server/youtube-actions';

const ITEMS: Array<{ key: keyof MonetizationAttestations; label: string }> = [
  { key: 'twoStep', label: '2-Step Verification is enabled on the Google Account' },
  { key: 'noStrikes', label: 'No active Community Guidelines strikes' },
  { key: 'adsenseLinked', label: 'An approved AdSense account is linked' },
  {
    key: 'regionEligible',
    label: 'The channel is in a region where the Partner Program is available',
  },
];

export function MonetizationAttestations({ initial }: { initial: MonetizationAttestations }) {
  const router = useRouter();
  const [values, setValues] = useState<MonetizationAttestations>(initial);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setMonetizationAttestationsAction(values);
          setSaved(r.ok);
          if (r.ok) router.refresh();
        });
      }}
    >
      <p className="text-muted-foreground text-xs">
        These are things the API cannot tell us. Your answers are stored as{' '}
        <span className="font-medium">your attestations</span> — they are treated as assumptions,
        not verified facts.
      </p>
      {ITEMS.map((item) => (
        <fieldset key={item.key} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="min-w-[16rem] flex-1">{item.label}</span>
          {(['yes', 'no', 'unsure'] as const).map((opt) => (
            <label key={opt} className="flex items-center gap-1">
              <input
                type="radio"
                name={item.key}
                checked={
                  opt === 'unsure'
                    ? values[item.key] === undefined
                    : values[item.key] === (opt === 'yes')
                }
                onChange={() =>
                  setValues((v) => ({
                    ...v,
                    [item.key]: opt === 'unsure' ? undefined : opt === 'yes',
                  }))
                }
              />
              {opt}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? 'Saving…' : 'Save attestations'}
        </Button>
        {saved ? <span className="text-muted-foreground text-xs">Saved.</span> : null}
      </div>
    </form>
  );
}

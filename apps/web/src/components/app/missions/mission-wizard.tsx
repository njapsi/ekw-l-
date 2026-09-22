'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Input, Label, Textarea } from '@growth-agent/ui';
import { createMissionAction, planMissionAction } from '@/server/mission-actions';

const PLATFORMS = [
  { key: 'YOUTUBE', label: 'YouTube' },
  { key: 'TIKTOK', label: 'TikTok' },
  { key: 'SEO', label: 'Website' },
  { key: 'WORDPRESS', label: 'WordPress' },
] as const;

const AUTONOMY_LEVELS = [
  { key: 'ADVISORY', label: 'Advisory — analyze and recommend only, no actions' },
  { key: 'ASSISTED', label: 'Ask before every action (recommended)' },
  { key: 'SUPERVISED', label: 'Let low-risk actions I authorize run automatically' },
  { key: 'CONTROLLED', label: 'Run pre-approved action classes automatically' },
] as const;

export function MissionWizard() {
  const router = useRouter();
  const [objective, setObjective] = useState('');
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [autonomyLevel, setAutonomyLevel] = useState('ASSISTED');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function togglePlatform(key: string) {
    setPlatforms((prev) => (prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key]));
  }

  async function submit() {
    setPending(true);
    setError(null);
    const targetDate = new Date(Date.now() + days * 86_400_000).toISOString();
    const created = await createMissionAction({
      name: name.trim() || objective.slice(0, 80),
      objective,
      targetDate,
      platforms: platforms.length > 0 ? platforms : undefined,
      autonomyLevel,
    });
    if (!created.ok || !created.missionId) {
      setError(created.error ?? 'Could not create the mission.');
      setPending(false);
      return;
    }
    const planned = await planMissionAction(created.missionId);
    setPending(false);
    if (!planned.ok) {
      // The mission exists as a draft even if planning failed — let the
      // user retry planning from its detail page rather than losing it.
      router.push(`/app/missions/${created.missionId}`);
      return;
    }
    router.push(`/app/missions/${created.missionId}`);
  }

  return (
    <form
      className="max-w-2xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="mission-objective">What do you want to accomplish?</Label>
        <Textarea
          id="mission-objective"
          rows={3}
          placeholder="e.g. Help me grow my website's organic traffic"
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mission-name">Name this mission (optional)</Label>
        <Input
          id="mission-name"
          placeholder="Grow organic traffic"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="mission-days">Over what period?</Label>
        <div className="flex items-center gap-2">
          <Input
            id="mission-days"
            type="number"
            min={7}
            max={365}
            className="w-24"
            value={days}
            onChange={(e) => setDays(Number(e.target.value) || 90)}
          />
          <span className="text-muted-foreground text-sm">days</span>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Which platforms? (leave blank for all connected)</legend>
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => togglePlatform(p.key)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                platforms.includes(p.key)
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-input text-foreground'
              }`}
              aria-pressed={platforms.includes(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How much autonomy?</legend>
        <div className="space-y-2">
          {AUTONOMY_LEVELS.map((l) => (
            <label key={l.key} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="autonomy"
                className="mt-1"
                checked={autonomyLevel === l.key}
                onChange={() => setAutonomyLevel(l.key)}
              />
              <span>{l.label}</span>
            </label>
          ))}
        </div>
        <p className="text-muted-foreground text-xs">
          Publishing, deleting, and any consequential change always require your approval, at every
          level.
        </p>
      </fieldset>

      <Button type="submit" disabled={pending || !objective.trim()}>
        {pending ? 'Building plan…' : 'Build mission plan'}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </form>
  );
}

'use client';

import { Monitor, Moon, Sun } from 'lucide-react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  useTheme,
  type ThemePreference,
} from '@growth-agent/ui';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

/** Light / dark / system toggle (Part 30). Persists per-viewer via
 * localStorage (`ThemeProvider`); nothing server-side depends on it. */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Current = OPTIONS.find((o) => o.value === theme)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}. Change theme`}>
          <Current className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-36">
        {OPTIONS.map((opt) => (
          <DropdownMenuItem key={opt.value} onSelect={() => setTheme(opt.value)}>
            <opt.icon className="size-4" aria-hidden />
            <span className="flex-1">{opt.label}</span>
            {theme === opt.value ? <span aria-hidden>✓</span> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

'use client';

import * as React from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'growth-agent-theme';

/**
 * Applies both the `data-theme` attribute (this package's own CSS selector,
 * `styles.css`) and the `.dark` class (what the Tailwind preset's
 * `darkMode: ['class']` expects for every `dark:` utility already written
 * against Tailwind's own convention) so either mechanism resolves the same
 * theme. `system` clears both and lets `prefers-color-scheme` decide.
 */
function applyTheme(preference: ThemePreference) {
  const root = document.documentElement;
  if (preference === 'system') {
    root.removeAttribute('data-theme');
    root.classList.remove('dark');
    return;
  }
  root.setAttribute('data-theme', preference);
  root.classList.toggle('dark', preference === 'dark');
}

/**
 * Render-blocking `<head>` script tag that reads the stored preference and
 * applies it before first paint (the standard anti-FOUC pattern for a
 * class/attribute-based theme). The body lives in the app's own
 * `public/theme-init.js` (a same-origin external file, not an inline
 * `dangerouslySetInnerHTML` string — this codebase has zero of those and
 * this component keeps it that way). `<html suppressHydrationWarning>` is
 * required on the root layout because this script mutates attributes React
 * did not render.
 */
export function ThemeScript() {
  return <script src="/theme-init.js" />;
}

interface ThemeContextValue {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<ThemePreference>('system');

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark' || stored === 'system') {
        setThemeState(stored);
      }
    } catch {
      /* localStorage unavailable (private mode, blocked) — default stands */
    }
  }, []);

  const setTheme = React.useCallback((next: ThemePreference) => {
    setThemeState(next);
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* per-viewer convenience only; failing to persist is not an error */
    }
  }, []);

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

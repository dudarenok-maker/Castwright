/* Plan 41 — theme resolution + DOM application.

   Single source of truth for "what theme should the page paint right
   now?". Combines three inputs in priority order:

   1. `ui.themeOverride`        — device-local quick toggle (redux-persist)
   2. `account.defaultThemePreference` — server-persisted user default
   3. OS `prefers-color-scheme` — when the resolved mode is `'system'`

   Writes the resolved theme to `<html data-theme="…">` so the CSS
   `[data-theme="dark"]` block in styles.css takes effect. The pre-mount
   guard in src/main.tsx covers cold-boot paint; this hook keeps the
   attribute in sync with React state for the rest of the session. */

import { useEffect, useSyncExternalStore } from 'react';
import { useAppSelector } from '../store';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Read the OS scheme exactly once, synchronously. Defaults to `'light'`
    when `matchMedia` is unavailable (older jsdom, server render). */
export function readSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return 'light';
  }
  return window.matchMedia(MEDIA_QUERY).matches ? 'dark' : 'light';
}

/** Resolve a preference triple down to a paintable 'light' | 'dark'. */
export function resolveTheme(
  override: ThemePreference | null,
  accountDefault: ThemePreference,
  systemTheme: ResolvedTheme,
): ResolvedTheme {
  const mode: ThemePreference = override ?? accountDefault;
  return mode === 'system' ? systemTheme : mode;
}

/* useSyncExternalStore adapter for the prefers-color-scheme media query.
   Subscribing re-renders the hook when the OS scheme flips (e.g. macOS
   sundown auto-switch), without a manual effect + state pair. */
function subscribeSystemTheme(notify: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(MEDIA_QUERY);
  /* Safari < 14 doesn't implement addEventListener on MediaQueryList; the
     legacy addListener / removeListener is still there. */
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', notify);
    return () => mql.removeEventListener('change', notify);
  }
  mql.addListener(notify);
  return () => mql.removeListener(notify);
}

function getSystemThemeSnapshot(): ResolvedTheme {
  return readSystemTheme();
}

function getServerSystemThemeSnapshot(): ResolvedTheme {
  return 'light';
}

/** Subscribe to the OS scheme via React's concurrent-safe external-store API.
    Returns 'light' | 'dark' and re-renders on a real OS flip. */
export function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(
    subscribeSystemTheme,
    getSystemThemeSnapshot,
    getServerSystemThemeSnapshot,
  );
}

/** Read the resolved theme and write it to `<html data-theme="…">` on every
    change. Intended to be mounted once at the root (layout.tsx). */
export function useTheme(): ResolvedTheme {
  const override       = useAppSelector(s => s.ui.themeOverride);
  const accountDefault = useAppSelector(s => s.account.defaultThemePreference ?? 'system');
  const systemTheme    = useSystemTheme();
  const theme          = resolveTheme(override, accountDefault, systemTheme);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return theme;
}

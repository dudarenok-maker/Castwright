/* Plan 41 — top-bar quick toggle. Cycles light → dark → system.

   Writes to ui.themeOverride (device-local, redux-persist). The actual
   paint is owned by useTheme() in src/lib/use-theme.ts — this component
   only reads the current override to render the right icon and label.
   "system" here means "follow the OS prefers-color-scheme"; the icon
   for that mode is the monitor glyph so it visually reads as
   "device-driven" rather than "manual choice". */

import { useAppDispatch, useAppSelector } from '../store';
import { uiActions } from '../store/ui-slice';
import { IconSun, IconMoon, IconMonitor } from '../lib/icons';
import type { ThemePreference } from '../lib/use-theme';

const CYCLE_ORDER: ThemePreference[] = ['system', 'light', 'dark'];

const LABELS: Record<ThemePreference, string> = {
  system: 'Theme: System (follows OS) — click to switch to Light',
  light: 'Theme: Light — click to switch to Dark',
  dark: 'Theme: Dark — click to switch to System',
};

function nextMode(current: ThemePreference): ThemePreference {
  const idx = CYCLE_ORDER.indexOf(current);
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
}

function iconFor(mode: ThemePreference) {
  if (mode === 'light') return <IconSun className="w-4 h-4" />;
  if (mode === 'dark') return <IconMoon className="w-4 h-4" />;
  return <IconMonitor className="w-4 h-4" />;
}

export function ThemeToggleButton() {
  const dispatch = useAppDispatch();
  const override = useAppSelector((s) => s.ui.themeOverride);
  const accountDefault = useAppSelector((s) => s.account.defaultThemePreference ?? 'system');
  /* When no device override is set we render the account default's icon
     so the affordance always reflects the *current* effective mode, not
     a phantom "no choice yet". Clicking then writes a real override. */
  const currentMode: ThemePreference = override ?? accountDefault;

  const onClick = () => {
    dispatch(uiActions.setThemeOverride(nextMode(currentMode)));
  };

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="theme-toggle"
      data-theme-mode={currentMode}
      aria-label={LABELS[currentMode]}
      title={LABELS[currentMode]}
      className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-ink/[0.04] hover:bg-ink/[0.08] text-ink/70 hover:text-ink transition-colors focus:outline-none focus:ring-2 focus:ring-magenta/40"
    >
      {iconFor(currentMode)}
    </button>
  );
}

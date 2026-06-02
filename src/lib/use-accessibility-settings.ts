/* fe-2 — apply accessibility settings to the document.
 *
 * Reads the device-local settings slice and reflects it onto `<html>`, the same
 * shape as use-theme's `data-theme` write:
 *
 *   - high-contrast → `<html data-contrast="high">`, which the
 *     `[data-contrast='high']` token-override layer in styles.css keys on
 *     (composes with both light and dark).
 *   - text scale    → root `font-size` percentage; Tailwind's rem-based type
 *     scale then scales the whole UI.
 *
 * Mounted once at the root (layout.tsx), alongside useTheme(). */

import { useEffect } from 'react';
import { useAppSelector } from '../store';
import { TEXT_SCALE_PERCENT } from './keybindings';

export function useAccessibilitySettings(): void {
  /* Optional-chained with defaults so a minimal test store that omits the
     settings slice still renders Layout (the real store always wires it). */
  const highContrast = useAppSelector((s) => s.settings?.highContrast ?? false);
  const textScale = useAppSelector((s) => s.settings?.textScale ?? 'normal');

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (highContrast) root.dataset.contrast = 'high';
    else delete root.dataset.contrast;
  }, [highContrast]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const pct = TEXT_SCALE_PERCENT[textScale];
    /* Leave the stylesheet's default untouched at 'normal' (don't pin an
       inline font-size we'd have to keep in sync); only override when scaled. */
    root.style.fontSize = pct === 100 ? '' : `${pct}%`;
  }, [textScale]);
}

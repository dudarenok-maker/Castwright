/* Plan 89 C5 — Suspense fallback that only paints if the wrapped boundary
   hasn't resolved within `delayMs`. Browser-cached navigations resolve a
   `React.lazy` chunk on the next microtask; mounting an immediately-visible
   spinner would flash for one frame on every cached route transition, which
   reads as "the app is slow." The delay reverses the trade: only show the
   spinner when the chunk genuinely had to download / decompress.

   Contract: when the Suspense boundary unmounts (chunk loaded), the spinner
   is unmounted too — there's no fade-in stagger, the boundary just swaps
   directly to the rendered view. This is the desired UX:
   - Warm-cache nav: spinner never paints; the view appears as if it had
     been a sync render.
   - Cold-cache nav: 150 ms after navigation, the spinner appears; once
     the chunk finishes resolving, the view replaces the spinner.

   Implementation: useState-gated visibility. Returns null until the timer
   fires; if the parent Suspense unmounts before the timer, the spinner
   simply never renders. */

import { useEffect, useState } from 'react';
import { IconSpinner } from '../lib/icons';

export interface DelayedSpinnerProps {
  /** Delay in ms before the spinner becomes visible. Defaults to 150 ms
   *  (Plan 89 C5 contract — short enough to feel like "loading" instead of
   *  "frozen" once perceived, long enough that a warm-cache resolve runs
   *  silently). */
  delayMs?: number;
  /** Optional label rendered beneath the spinner — primarily for
   *  screen-reader users. The visible label also keeps the fallback's
   *  layout from collapsing to a single icon, which read as "broken UI"
   *  during early testing. */
  label?: string;
}

export function DelayedSpinner({ delayMs = 150, label = 'Loading…' }: DelayedSpinnerProps) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(id);
  }, [delayMs]);
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="route-suspense-fallback"
      className="flex flex-col items-center justify-center gap-3 py-16 text-ink/55"
    >
      <IconSpinner className="w-8 h-8" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

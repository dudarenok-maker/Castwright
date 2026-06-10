/* fs-1 — post-upgrade "What's new in vX.Y.Z" banner. Renders at the top of every
   view (mounted in layout.tsx after the top bar) whenever the server reports
   showWhatsNew. Dismiss clears the flag via POST /api/info/dismiss-whats-new and
   re-fetches so it stays gone across reloads. In mock mode showWhatsNew is off,
   so this never paints a phantom banner. */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAppInfo } from '../lib/use-app-info';
import { latestReleaseNote } from '../lib/release-notes';

export function WhatsNewBanner() {
  const { info, refresh } = useAppInfo();
  const [dismissing, setDismissing] = useState(false);

  if (!info?.showWhatsNew) return null;

  const onDismiss = async () => {
    setDismissing(true);
    try {
      await api.dismissWhatsNew();
      await refresh();
    } catch {
      /* leave the banner up if the dismiss call fails; the user can retry */
    } finally {
      setDismissing(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="whats-new-banner"
      className="mx-4 mt-3 rounded-xl border border-magenta/20 bg-peach/40 px-4 py-3 text-ink"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-sm font-semibold text-magenta">What&apos;s new in v{info.appVersion}</h2>
        <button
          type="button"
          onClick={onDismiss}
          disabled={dismissing}
          className="min-h-[44px] sm:min-h-0 shrink-0 rounded-lg px-3 py-1 text-xs font-medium text-ink/70 hover:bg-white/60 disabled:opacity-50"
        >
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>
      {(() => {
        // Multi-version notes (fe-37): show ONLY the latest section here; the
        // full history lives at #/release-notes. Bullets render plain (the
        // **bold** lead-in markers are stripped for the compact banner).
        const latest = latestReleaseNote(info.releaseNotes);
        if (!latest || latest.bullets.length === 0) return null;
        return (
          <>
            <ul className="mt-2 space-y-1 list-disc pl-4 text-xs text-ink/75">
              {latest.bullets.slice(0, 5).map((b, i) => (
                <li key={i}>{b.replace(/\*\*/g, '')}</li>
              ))}
            </ul>
            <Link
              to="/release-notes"
              className="mt-2 inline-block text-xs font-medium text-magenta hover:underline"
            >
              See all release notes
            </Link>
          </>
        );
      })()}
    </div>
  );
}

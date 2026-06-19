/* fe-27 — in-app update notifier. Renders at the top of every view (mounted in
   layout.tsx after WhatsNewBanner) when the server reports a newer release the
   user hasn't dismissed. Dismiss silences it for that exact version (the dot in
   the version pill clears in the same tick via the shared update-notice store).
   Dark in mock mode unless ?e2eUpdate is set. */

import { Link } from 'react-router-dom';
import { useAppInfo } from '../lib/use-app-info';
import { useDismissedVersion, dismissUpdate, shouldShowUpdateNotice } from '../lib/update-notice';

export function UpdateNotifierBanner() {
  const { info } = useAppInfo();
  const dismissed = useDismissedVersion();
  if (!shouldShowUpdateNotice(info ?? null, dismissed)) return null;

  const latest = info!.latestVersion!;
  return (
    <div
      role="status"
      data-testid="update-notifier-banner"
      className="mx-4 mt-3 rounded-xl border border-magenta/20 bg-peach/40 px-4 py-3 text-ink"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-magenta">Update available — v{latest}</p>
        <div className="flex items-center gap-2">
          <Link to="/release-notes" className="text-xs font-medium text-magenta hover:underline">
            See what&apos;s new
          </Link>
          <button
            type="button"
            onClick={() => dismissUpdate(latest)}
            className="min-h-[44px] sm:min-h-0 shrink-0 rounded-lg px-3 py-1 text-xs font-medium text-ink/70 hover:bg-white/60"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

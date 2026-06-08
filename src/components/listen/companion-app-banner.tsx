/* Listen-view first-party entry — the Castwright Companion mobile app.
   Renders above the third-party "Listen on your favourite app" grid as a
   full-width branded banner. The store links are mocked for now: the
   "Coming soon" badge carries the not-live message and both buttons are
   inert (disabled). Flip each button to a real <a href> once the app is
   published. */

import { CastwaveMark, IconApple, IconPlay } from '../../lib/icons';
import { ComingSoonBadge } from '../primitives';

export function CompanionAppBanner() {
  return (
    <section className="mb-8 md:mb-12" data-testid="companion-app-banner">
      <div className="rounded-3xl border border-magenta/15 shadow-card bg-gradient-to-br from-peach/15 to-magenta/5 p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6">
        <span className="w-14 h-14 rounded-2xl bg-white shadow-card grid place-items-center text-ink shrink-0">
          <CastwaveMark className="w-8 h-8" aria-hidden="true" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-lg font-bold text-ink leading-tight">Castwright Companion</h3>
            <ComingSoonBadge />
          </div>
          <p className="text-sm text-ink/65 mt-1 leading-relaxed">
            Take your full-cast audiobooks anywhere — download to your phone for offline listening.
          </p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 shrink-0">
          <StoreButton
            testid="companion-store-google-play"
            label="Google Play"
            ariaLabel="Get the Castwright Companion on Google Play — coming soon"
            icon={<IconPlay className="w-4 h-4" />}
          />
          <StoreButton
            testid="companion-store-app-store"
            label="App Store"
            ariaLabel="Download the Castwright Companion on the App Store — coming soon"
            icon={<IconApple className="w-4 h-4" />}
          />
        </div>
      </div>
    </section>
  );
}

/* Mocked store button — visually a real install CTA, but disabled while
   the app is unpublished. `aria-label` spells out the coming-soon state
   for assistive tech (the visible label is just the store name). */
function StoreButton({
  testid,
  label,
  ariaLabel,
  icon,
}: {
  testid: string;
  label: string;
  ariaLabel: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled
      data-testid={testid}
      aria-label={ariaLabel}
      title={`${label} — coming soon`}
      className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold bg-ink/5 text-ink/45 cursor-not-allowed"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

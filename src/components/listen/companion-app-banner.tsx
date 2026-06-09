/* Listen-view first-party entry — the Castwright Companion mobile app.
   Renders above the third-party "Listen on your favourite app" grid as a
   full-width branded banner.

   The two store buttons (Google Play / App Store) are mocked placeholders —
   the "Coming soon" badge carries the not-live message and both stay disabled
   until the app actually lists. The interim "third distribution method" is a
   direct APK download: when the server has an APK dropped at its resolved
   location (probed via api.checkCompanionApk → HEAD /api/companion/apk), a real
   "Download .apk" link appears; otherwise it stays hidden. */

import { useEffect, useState } from 'react';

import { CastwaveMark, IconApple, IconDownload, IconPlay, IconQrCode } from '../../lib/icons';
import { ComingSoonBadge } from '../primitives';
import { PairDeviceModal } from '../../modals/pair-device';
import { api } from '../../lib/api';
import type { CompanionApkAvailability } from '../../lib/types';

/* Same-origin route the server streams the packaged APK from (attachment). */
const APK_DOWNLOAD_URL = '/api/companion/apk';

export function CompanionAppBanner() {
  const [apk, setApk] = useState<CompanionApkAvailability | null>(null);
  const [pairOpen, setPairOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.checkCompanionApk().then((r) => {
      if (!cancelled) setApk(r);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
          {apk?.available && (
            <ApkDownloadButton
              sizeBytes={apk.sizeBytes}
            />
          )}
          <button
            type="button"
            onClick={() => setPairOpen(true)}
            data-testid="companion-pair-device"
            aria-label="Pair a device with the Castwright Companion"
            className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold border border-magenta/30 text-magenta hover:bg-magenta/5 transition-colors"
          >
            <IconQrCode className="w-4 h-4" />
            <span>Pair a device</span>
          </button>
        </div>
      </div>
      <PairDeviceModal open={pairOpen} onClose={() => setPairOpen(false)} />
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

/* The live interim affordance — a real attachment download served by the
   server. The browser saves the APK (Content-Disposition: attachment) rather
   than navigating. Shows a size hint when the server reported one. */
function ApkDownloadButton({ sizeBytes }: { sizeBytes: number | null }) {
  const hint = sizeBytes != null ? formatBytes(sizeBytes) : null;
  return (
    <a
      href={APK_DOWNLOAD_URL}
      download
      data-testid="companion-store-apk"
      aria-label="Download the Castwright Companion Android APK"
      className="min-h-[44px] inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold bg-ink text-canvas hover:bg-ink-soft transition-colors"
    >
      <IconDownload className="w-4 h-4" />
      <span>Download .apk</span>
      {hint && <span className="text-[11px] font-normal text-canvas/70">{hint}</span>}
    </a>
  );
}

/** Compact byte-size label for the download hint — KB under 1 MB, else MB. */
function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${Math.round(n / (1024 * 1024))} MB`;
}

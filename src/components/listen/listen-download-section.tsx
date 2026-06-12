/* Listen-view download region — pure presentational lift
   from listen.tsx. Owns: the Castwright Companion app banner (mocked
   store links), the "Listen on your favourite app" cards
   (PocketBook / Voice / Smart AudioBook / BookPlayer / Audiobookshelf /
   Apple Books tiles — all six live), the Export queue rail with per-row
   actions, and the three "Or download a file" tiles (M4B chaptered,
   MP3 ZIP, streaming link — plan 57).

   Behaviour-neutral lift — every data-testid, className, and child
   order matches the pre-refactor JSX so the listen.test.tsx +
   download-tiles e2e selectors keep resolving. The export modal +
   cover picker still live on the parent (state-driven) so the open-
   modal handlers thread through props from listen.tsx. */

import { useState } from 'react';
import { IconDownload, IconExternal, IconShield } from '../../lib/icons';
import { SectionLabel, Pill, ComingSoonBadge } from '../primitives';
import { ExportQueueRow } from '../export-queue-row';
import { CompanionAppBanner } from './companion-app-banner';
import { SUPPORTED_APPS } from '../../data/listener-apps';
import type { ListenerApp, ExportQueueItem } from '../../lib/types';

interface ListenDownloadSectionProps {
  queueItems: ExportQueueItem[];
  onOpenPocketBookExport: () => void;
  onOpenVoiceExport: () => void;
  onOpenSmartAudiobookExport: () => void;
  onOpenBookplayerExport: () => void;
  onOpenAudiobookshelfExport: () => void;
  onOpenAppleBooksExport: () => void;
  onOpenM4bExport: () => void;
  onOpenMp3ZipExport: () => void;
  /** Plan 67 — streaming-link tile handler. Called when the user clicks
      the Download button on the Streaming link tile. The orchestrator
      mints the share URL + opens the share-link modal. */
  onOpenStreamingLink: () => void;
  /** Plan 75 — portable book bundle tile. Called when the user clicks
      Download on the "Portable bundle" tile. The orchestrator calls
      api.exportPortable(bookId) and saves the returned Blob. */
  onPortableBundleExport?: () => void;
  onCopyExportLink: (item: ExportQueueItem) => Promise<void> | void;
  onRemoveExport: (item: ExportQueueItem) => void;
  /* Plan 82 — Retry on `failed` rows re-fires the original export via
     the exports-middleware `retryExport` thunk (reads `bookId` +
     `exportId` + `wireFormat` + `wireDestination` + `syncPath` off the
     item). Download on `done` rows without a signed `url` builds the
     `/api/books/{bookId}/exports/{exportId}/download` URL. Both
     handlers are optional — the listen view wires them; the export
     modal preview row still only wires Download. */
  onRetryExport?: (item: ExportQueueItem) => void;
  onDownloadExport?: (item: ExportQueueItem) => void;
}

export function ListenDownloadSection({
  queueItems,
  onOpenPocketBookExport,
  onOpenVoiceExport,
  onOpenSmartAudiobookExport,
  onOpenBookplayerExport,
  onOpenAudiobookshelfExport,
  onOpenAppleBooksExport,
  onOpenM4bExport,
  onOpenMp3ZipExport,
  onOpenStreamingLink,
  onPortableBundleExport,
  onCopyExportLink,
  onRemoveExport,
  onRetryExport,
  onDownloadExport,
}: ListenDownloadSectionProps) {
  return (
    <>
      <CompanionAppBanner />
      <ListenerApps
        onOpenPocketBookExport={onOpenPocketBookExport}
        onOpenVoiceExport={onOpenVoiceExport}
        onOpenSmartAudiobookExport={onOpenSmartAudiobookExport}
        onOpenBookplayerExport={onOpenBookplayerExport}
        onOpenAudiobookshelfExport={onOpenAudiobookshelfExport}
        onOpenAppleBooksExport={onOpenAppleBooksExport}
      />
      <ExportQueue
        items={queueItems}
        onCopyLink={onCopyExportLink}
        onRemove={onRemoveExport}
        onRetry={onRetryExport}
        onDownload={onDownloadExport}
      />

      <section className="mb-8 md:mb-12">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionLabel>Or download a file</SectionLabel>
          <span className="text-xs text-ink/50">For sideloading or archival</span>
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
          <DownloadCard
            title="Full audiobook"
            format="m4b chaptered"
            size="—"
            description="Single file with embedded chapter markers. Universal across audiobook apps."
            testid="download-tile-m4b"
            tourId="download-tile-m4b"
            onDownload={onOpenM4bExport}
          />
          <DownloadCard
            title="MP3 ZIP"
            format="zipped per-chapter mp3s"
            size="—"
            description="One zip with every chapter as an MP3 inside. Good for folder-scanning players."
            testid="download-tile-mp3-zip"
            onDownload={onOpenMp3ZipExport}
          />
          <DownloadCard
            title="Streaming link"
            format="Shareable URL"
            size="—"
            description="Hosted link a listener can open in a browser. Resolves to the book's M4B."
            testid="download-tile-streaming"
            onDownload={onOpenStreamingLink}
          />
          <DownloadCard
            title="Portable bundle"
            format="full backup .zip"
            size="—"
            description="Full backup (state + manuscript + audio + cover) for re-importing on another machine."
            testid="download-tile-portable"
            onDownload={onPortableBundleExport}
          />
        </div>
      </section>
    </>
  );
}

function DownloadCard({
  title,
  format,
  size,
  description,
  onDownload,
  testid,
  tourId,
}: {
  title: string;
  format: string;
  size: string;
  description: string;
  /** Plan 57 — when present, the tile is live: the button is enabled
      and clicking it invokes the handler (typically opens the export
      modal with the right format/destination pre-filled). Tiles without
      a handler retain the "Coming soon" affordance. */
  onDownload?: () => void;
  testid?: string;
  tourId?: string;
}) {
  const live = onDownload != null;
  return (
    <div
      className="rounded-3xl border p-4 sm:p-6 transition-all bg-white border-ink/10 shadow-card relative"
      data-testid={testid}
    >
      <div className="flex items-start justify-between mb-3">
        <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50">{format}</p>
        {!live && <ComingSoonBadge />}
      </div>
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="text-lg font-bold text-ink">{title}</h3>
        <span className="text-xs tabular-nums text-ink/60">{size}</span>
      </div>
      <p className="text-xs leading-relaxed mb-5 text-ink/60">{description}</p>
      <button
        type="button"
        onClick={live ? onDownload : undefined}
        disabled={!live}
        title={live ? 'Download' : 'Download — coming soon'}
        {...(tourId ? { 'data-tour-id': tourId } : {})}
        className={
          live
            ? 'min-h-[44px] w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors bg-ink text-canvas hover:bg-ink/90'
            : 'min-h-[44px] w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors bg-ink/3 text-ink/40 cursor-not-allowed'
        }
      >
        <IconDownload className="w-4 h-4" /> Download
      </button>
    </div>
  );
}

interface ListenerAppsProps {
  /** PocketBook is live: clicking its tile opens the export modal on the
      Download-to-phone tab. */
  onOpenPocketBookExport: () => void;
  /** Voice is live: clicking its tile opens the export modal pre-set to
      M4B + sync-folder with appHint='voice' so the format and destination
      toggles are hidden. */
  onOpenVoiceExport: () => void;
  /** Smart AudioBook Player is live (plan 34 B2): mp3-folder + sync-folder
      with appHint='smart_audiobook'. */
  onOpenSmartAudiobookExport: () => void;
  /** BookPlayer is live (plan 34 B3): mp3-folder + sync-folder with
      appHint='bookplayer'. iOS via Files import or AirDrop from a Mac. */
  onOpenBookplayerExport: () => void;
  /** Audiobookshelf is live (plan 34 B4): mp3-folder + sync-folder with
      appHint='audiobookshelf'. Self-hosted server scans the library
      root for folders. */
  onOpenAudiobookshelfExport: () => void;
  /** Apple Books is live: imports a chaptered M4B on macOS/iOS, same
      download-tab + M4B-format prefill as PocketBook. */
  onOpenAppleBooksExport: () => void;
}
function ListenerApps({
  onOpenPocketBookExport,
  onOpenVoiceExport,
  onOpenSmartAudiobookExport,
  onOpenBookplayerExport,
  onOpenAudiobookshelfExport,
  onOpenAppleBooksExport,
}: ListenerAppsProps) {
  /* Per-app live handlers. Tiles not in this map render as disabled
     coming-soon placeholders. */
  const liveHandlers: Record<string, () => void> = {
    pocketbook: onOpenPocketBookExport,
    voice: onOpenVoiceExport,
    smart_audiobook: onOpenSmartAudiobookExport,
    bookplayer: onOpenBookplayerExport,
    audiobookshelf: onOpenAudiobookshelfExport,
    apple_books: onOpenAppleBooksExport,
  };
  return (
    <section className="mb-8 md:mb-12">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionLabel>Listen on your favourite app</SectionLabel>
        <span className="text-xs text-ink/50 inline-flex items-center gap-1.5">
          <IconShield className="w-3.5 h-3.5" /> Open-format export · DRM-free
        </span>
      </div>
      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
        {SUPPORTED_APPS.map((a) => (
          <ListenerAppCard
            key={a.id}
            app={a}
            onOpenLiveExport={liveHandlers[a.id]}
          />
        ))}
      </div>
      <p className="mt-4 text-xs text-ink/50 text-center">
        Don't see your app? Any player that supports MP3.ZIP or M4B with chapter markers will work —
        use the manual download below.
      </p>
    </section>
  );
}

interface ListenerAppCardProps {
  app: ListenerApp;
  /** Present only for live tiles (PocketBook, Voice, Smart AudioBook
      Player). When set, turns the
      disabled-placeholder pill into a real button. */
  onOpenLiveExport?: () => void;
}
function ListenerAppCard({ app, onOpenLiveExport }: ListenerAppCardProps) {
  const [from, to] = app.gradient;
  const isLive = onOpenLiveExport != null;
  return (
    <article
      data-testid={`listener-app-${app.id}`}
      className="bg-white rounded-3xl border border-ink/10 shadow-card p-4 sm:p-5 flex flex-col"
    >
      <div className="flex items-start gap-3 mb-3">
        <span
          className="w-12 h-12 rounded-2xl shadow-card grid place-items-center text-white font-bold text-sm shrink-0"
          style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}
        >
          {app.glyph}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-bold text-ink leading-tight">{app.name}</h3>
            {isLive ? null : <ComingSoonBadge />}
          </div>
          <p className="text-xs text-ink/55 mt-0.5">{app.tagline}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-1 mb-3">
        {app.platforms.map((p) => (
          <Pill key={p}>{p}</Pill>
        ))}
      </div>
      <p className="text-xs text-ink/65 leading-relaxed mb-5 flex-1">{app.description}</p>
      {isLive ? (
        <button
          onClick={onOpenLiveExport}
          data-testid={`listener-app-action-${app.id}`}
          className="min-h-[44px] w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors bg-ink text-canvas hover:bg-ink-soft"
        >
          <IconExternal className="w-4 h-4" /> {app.sendVerb}
        </button>
      ) : (
        <button
          disabled
          title={`${app.sendVerb} — coming soon`}
          data-testid={`listener-app-action-${app.id}`}
          className="min-h-[44px] w-full inline-flex items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors bg-ink/3 text-ink/40 cursor-not-allowed"
        >
          <IconExternal className="w-4 h-4" /> {app.sendVerb}
        </button>
      )}
    </article>
  );
}

type QueueFilter = 'all' | 'done' | 'in_progress' | 'failed';

function ExportQueue({
  items,
  onCopyLink,
  onRemove,
  onRetry,
  onDownload,
}: {
  items: ExportQueueItem[];
  onCopyLink?: (item: ExportQueueItem) => void;
  onRemove?: (item: ExportQueueItem) => void;
  onRetry?: (item: ExportQueueItem) => void;
  onDownload?: (item: ExportQueueItem) => void;
}) {
  const [filter, setFilter] = useState<QueueFilter>('all');
  const visible = items.filter((it) => filter === 'all' || it.status === filter);
  const counts = {
    all: items.length,
    done: items.filter((it) => it.status === 'done').length,
    in_progress: items.filter((it) => it.status === 'in_progress').length,
    failed: items.filter((it) => it.status === 'failed').length,
  };
  const filters: Array<{ id: QueueFilter; label: string }> = [
    { id: 'all', label: `All (${counts.all})` },
    { id: 'done', label: `Done (${counts.done})` },
    { id: 'in_progress', label: `Running (${counts.in_progress})` },
    { id: 'failed', label: `Failed (${counts.failed})` },
  ];
  return (
    <section data-testid="export-queue-rail" className="mb-8 md:mb-12">
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionLabel>Export queue</SectionLabel>
        <div className="flex items-center gap-1 bg-ink/4 rounded-full p-0.5 text-xs flex-wrap">
          {filters.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`min-h-[32px] px-3 py-1.5 rounded-full font-medium transition-colors ${filter === f.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5">
        {visible.length === 0 && (
          <p className="px-6 py-8 text-sm text-ink/50 text-center">No exports match this filter.</p>
        )}
        {visible.map((it) => (
          <ExportQueueRow
            key={it.id}
            item={it}
            onDownload={onDownload}
            onCopyLink={onCopyLink}
            onRemove={onRemove}
            onRetry={onRetry}
          />
        ))}
      </div>
    </section>
  );
}

/* Plan 60 — `ExportQueueItem` flows through props so the queue lives
   alongside the listener-apps + download tiles. The parent owns
   the live-vs-fixture decision and the per-row dispatch wiring. */

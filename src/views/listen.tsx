import { useMemo, useState } from 'react';
import { CoverPicker } from '../modals/cover-picker';
import { type CoverFraming } from '../lib/cover-framing';
import { ExportAudiobookModal } from '../modals/export-audiobook';
import { ShareLinkModal } from '../modals/share-link';
import { parseDuration } from '../lib/time';
import { EXPORT_QUEUE } from '../data/export-queue';
import { bookExportJobToQueueItem } from '../lib/export-queue-adapter';
import { useAppDispatch, useAppSelectorShallow } from '../store';
import { uiActions } from '../store/ui-slice';
import { listenProgressActions } from '../store/listen-progress-slice';
import { api } from '../lib/api';
import { exportsActions } from '../store/exports-slice';
import { retryExport } from '../store/exports-middleware';
import { notificationsActions } from '../store/notifications-slice';
import { ListenHeader, ListenMetadataEditor } from '../components/listen/listen-header';
import { ListenPlayerRegion } from '../components/listen/listen-player-region';
import { ListenDownloadSection } from '../components/listen/listen-download-section';
import type { Chapter, Character, Voice, ListenerApp, ExportQueueItem } from '../lib/types';
import type { EditableBookMeta, EditableBookMetaField } from '../store/book-meta-slice';

interface Props {
  /** Required so the Export modal can target the right book on POST.
      Plumbed through from the ListenRoute via state.ui.stage. */
  bookId: string;
  chapters: Chapter[];
  characters: Character[];
  library: Voice[];
  currentTrack: number | null;
  setCurrentTrack: (t: number | null) => void;
  onSendApp: (app: ListenerApp) => void;
  onRegenerate: (ch: Chapter) => void;
  onEnterPreview: () => void;
  /* Book-meta wiring (Listen header + metadata editor). When `bookMeta` is
     null the view has not yet hydrated for this book — render a minimal
     skeleton rather than the design fixture. */
  bookMeta: EditableBookMeta | null;
  bookCoverGradient: [string, string] | null;
  /** Server-relative URL for the cached OpenLibrary cover image when
      one exists for this book. Null falls back to the gradient. */
  bookCoverImageUrl?: string | null;
  /** Plan 40 — render-time pan + zoom applied to bookCoverImageUrl. */
  bookCoverFraming?: CoverFraming;
  /** Fired by the CoverPicker after a successful save/remove so the
      parent can refresh the library slice. */
  onCoverChanged?: () => Promise<void> | void;
  onEditMetaField: (field: EditableBookMetaField, value: string | null) => void;
  onCommitMeta: () => void;
  onCancelMeta: () => void;
  isMetaDirty: boolean;
}

export function ListenView({
  bookId,
  chapters,
  characters,
  currentTrack,
  setCurrentTrack,
  onSendApp,
  onRegenerate,
  onEnterPreview,
  bookMeta,
  bookCoverGradient,
  bookCoverImageUrl,
  bookCoverFraming,
  onCoverChanged,
  onEditMetaField,
  onCommitMeta,
  onCancelMeta,
  isMetaDirty,
}: Props) {
  /* CoverPicker modal state, plus a local override so the new image
     paints immediately after a successful pick (the prop will catch up
     on the next library hydrate). Empty string = the user just removed
     the cover; ignore the prop until the slice refresh resolves. Same
     pattern as BookCard in book-library.tsx. */
  const dispatch = useAppDispatch();
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  /* Per-open tab override. Reset when the modal closes so the next
     cover-tile click defaults back to the account preference. */
  const [coverPickerInitialTab, setCoverPickerInitialTab] = useState<
    'search' | 'upload' | undefined
  >(undefined);
  const openCoverPicker = (tab?: 'search' | 'upload') => {
    setCoverPickerInitialTab(tab);
    setCoverPickerOpen(true);
  };
  const [coverOverride, setCoverOverride] = useState<string | null>(null);
  /* Local framing override mirrors coverOverride for instant feedback
     between the picker's debounced PATCH and the slice rehydrate. */
  const [framingOverride, setFramingOverride] = useState<CoverFraming | null>(null);
  const effectiveFraming = framingOverride ?? bookCoverFraming;
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const effectiveCoverUrl =
    coverOverride !== null ? coverOverride || null : (bookCoverImageUrl ?? null);
  /* Local modal state for the export flow. Entry points:
     - The "Export audiobook" pill in the cover-art row (download tab,
       generic two-tab UX, no appHint).
     - The PocketBook tile (download tab — LAN/QR sideload story).
     - Per-app tiles (Voice, Smart AudioBook Player, …) that pass an
       appHint matching a TILE_HINTS entry in `src/modals/export-audiobook.tsx`.
       The modal collapses the format/destination toggles and surfaces
       tile-specific copy from that entry. */
  const [exportModal, setExportModal] = useState<{
    tab: 'download' | 'sync-folder';
    appHint?: 'voice' | 'smart_audiobook' | 'bookplayer' | 'audiobookshelf';
    /* Plan 57 — direct-format prefill from the download tiles (M4B,
       MP3 ZIP). Distinct from `appHint` which collapses the modal to a
       tile-specific UX; `format` keeps the generic two-tab UX with the
       picker pre-set. */
    format?: 'm4b' | 'mp3-zip' | 'mp3-folder';
  } | null>(null);
  /* Plan 67 — share-link modal state. `null` is closed; an object
     with a (possibly null) `url` lets us open the modal optimistically
     while the mint POST is in flight, then fill in the URL once the
     API resolves. */
  const [shareLink, setShareLink] = useState<{ url: string | null } | null>(null);

  /* Live job list from the store, with the visual fixtures as a fallback
     so design-system mode (VITE_USE_MOCKS=true with no live exports) keeps
     showing the demo content the prototype shipped with.
     Shallow-equal selector (plan 89 C3): the array's element identities are
     stable across unrelated `byBookId[otherBook]` ticks, so Listen on Book A
     should not re-render when Book B's exports advance. */
  const liveJobs = useAppSelectorShallow((s) => s.exports.byBookId[bookId] ?? []);
  const useMockFallback = import.meta.env.VITE_USE_MOCKS === 'true' && liveJobs.length === 0;
  const queueItems = useMemo<ExportQueueItem[]>(
    () => (useMockFallback ? EXPORT_QUEUE : liveJobs.map(bookExportJobToQueueItem)),
    [liveJobs, useMockFallback],
  );
  /* Excluded chapters (front/back-matter the user opted out of at the
     confirm-metadata stage) never get audio, so they have no business in
     the "ready to listen" rail or the runtime/chapter-count math — they'd
     surface as 00:00 rows and inflate the chapter total. The Generation
     view is the place to revisit exclusion choices. */
  const listenable = chapters.filter((c) => !c.excluded);
  const completed = listenable.filter((c) => c.state === 'done').length;
  const totalSec = listenable.reduce((s, c) => s + parseDuration(c.duration), 0);
  /* Narrator credit precedence: explicit override from bookMeta (or '' if the
     user cleared it) → the cast's narrator character → null. The header
     suppresses the "narrated by …" phrase when none of those resolve. */
  const narratorName =
    (bookMeta?.narratorCredit && bookMeta.narratorCredit.trim()) ||
    characters.find((c) => c.id === 'narrator')?.name ||
    null;
  /* `voiceCount` counts only the speaking cast (not the narrator) — matches the
     library card's "cast of N voices" copy and degrades gracefully when only
     the narrator is present. */
  const voiceCount = Math.max(0, characters.filter((c) => c.id !== 'narrator').length);

  const title = bookMeta?.title ?? '';
  const author = bookMeta?.author ?? '';
  return (
    <div className="max-w-[1200px] mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <ListenHeader
        title={title}
        author={author}
        narratorName={narratorName}
        voiceCount={voiceCount}
        totalSec={totalSec}
        chapterCount={listenable.length}
        completedCount={completed}
        hasListenable={listenable.length > 0}
        firstListenableId={listenable.length > 0 ? listenable[0].id : null}
        bookCoverGradient={bookCoverGradient}
        effectiveCoverUrl={effectiveCoverUrl}
        effectiveFraming={effectiveFraming}
        coverLoadFailed={coverLoadFailed}
        onCoverLoadFailed={() => setCoverLoadFailed(true)}
        onChangeCover={() => openCoverPicker()}
        onPlayFromStart={(id) => setCurrentTrack(id)}
        onOpenExportModal={() => setExportModal({ tab: 'download' })}
        onEnterPreview={onEnterPreview}
        onOpenRestructure={() => dispatch(uiActions.changeView('restructure'))}
        onReplaceManuscript={() => dispatch(uiActions.startReupload({ bookId }))}
        notes={bookMeta?.notes ?? null}
      />

      <ListenPlayerRegion
        bookId={bookId}
        chapters={chapters}
        listenable={listenable}
        characters={characters}
        currentTrack={currentTrack}
        onPlayChapter={(id) => setCurrentTrack(id)}
        onRegenerate={onRegenerate}
        onSeekMarker={(marker) => {
          /* Plan 53 — click a marker → reload that chapter into the
             mini-player AND stamp the per-book resume bookmark to
             marker.sec so the mini-player's onLoadedMetadata seek
             lands at the marker position. Persist as well so a
             reload arrives at the same spot.

             Two paths the mini-player needs covered:
             (a) marker chapter != currently-playing chapter → setCurrentTrack
                 triggers the chapter-mount effect, which reads
                 pendingSeekRef → onLoadedMetadata applies it.
             (b) marker chapter == currently-playing chapter → no
                 remount fires; the requestSeek dispatch below feeds
                 the mini-player's seek effect via the pendingSeek
                 selector. */
          dispatch(
            listenProgressActions.update({
              bookId,
              chapterId: marker.chapterId,
              currentSec: marker.sec,
            }),
          );
          /* Fire-and-forget — listen-view marker clicks are
             non-blocking. The mini-player's hydrate effect will
             re-fetch this on the next mount, so even a transient
             network failure isn't fatal. */
          void api
            .putListenProgress(bookId, {
              chapterId: marker.chapterId,
              currentSec: marker.sec,
            })
            .catch(() => {
              /* swallow — slice already optimistically updated */
            });
          dispatch(
            listenProgressActions.requestSeek({
              bookId,
              chapterId: marker.chapterId,
              sec: marker.sec,
            }),
          );
          setCurrentTrack(marker.chapterId);
        }}
        onDeleteMarker={(markerId) => {
          dispatch(listenProgressActions.deleteMarker({ bookId, markerId }));
        }}
      />

      <ListenDownloadSection
        queueItems={queueItems}
        onSendApp={onSendApp}
        onOpenPocketBookExport={() => setExportModal({ tab: 'download' })}
        onOpenVoiceExport={() => setExportModal({ tab: 'sync-folder', appHint: 'voice' })}
        onOpenSmartAudiobookExport={() =>
          setExportModal({ tab: 'sync-folder', appHint: 'smart_audiobook' })
        }
        onOpenBookplayerExport={() => setExportModal({ tab: 'sync-folder', appHint: 'bookplayer' })}
        onOpenAudiobookshelfExport={() =>
          setExportModal({ tab: 'sync-folder', appHint: 'audiobookshelf' })
        }
        onOpenM4bExport={() => setExportModal({ tab: 'download', format: 'm4b' })}
        onOpenMp3ZipExport={() => setExportModal({ tab: 'download', format: 'mp3-zip' })}
        onOpenStreamingLink={() => {
          /* Open the modal optimistically so the user sees the
             share-link UI immediately; the mint POST resolves into
             the URL field a moment later. Failures surface as a
             toast and re-close the modal. */
          setShareLink({ url: null });
          void api
            .createBookShareLink(bookId)
            .then((link) => setShareLink({ url: link.url }))
            .catch((err) => {
              setShareLink(null);
              dispatch(
                notificationsActions.pushToast({
                  kind: 'warn',
                  message: `Couldn't generate share link: ${err instanceof Error ? err.message : String(err)}`,
                  dedupeKey: 'share-link-mint-failed',
                }),
              );
            });
        }}
        onPortableBundleExport={() => {
          /* Plan 75 — fetch the bundle as a Blob and trigger a
             browser save-as via a temp anchor. The server's
             Content-Disposition already names the file
             "<slug>.portable.zip", but we set `download=` on the
             anchor too so Firefox / Safari pick it up reliably. */
          void api
            .exportPortable(bookId)
            .then((blob) => {
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${bookId}.portable.zip`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              /* Release the object URL after the click — the
                 download is already initiated, so revoking the
                 URL straight away doesn't cancel it. */
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
            .catch((err) => {
              dispatch(
                notificationsActions.pushToast({
                  kind: 'warn',
                  message: `Portable export failed: ${err instanceof Error ? err.message : String(err)}`,
                  dedupeKey: 'portable-export-failed',
                }),
              );
            });
        }}
        onCopyExportLink={async (item) => {
          if (!item.url) return;
          try {
            await navigator.clipboard.writeText(item.url);
            dispatch(
              notificationsActions.pushToast({
                kind: 'info',
                message: 'Link copied to clipboard',
                dedupeKey: 'export-link-copied',
              }),
            );
          } catch {
            dispatch(
              notificationsActions.pushToast({
                kind: 'warn',
                message: 'Could not copy — clipboard permission denied',
                dedupeKey: 'export-link-copy-failed',
              }),
            );
          }
        }}
        onRemoveExport={(item) => {
          dispatch(exportsActions.exportDismissed({ bookId, exportId: item.id }));
        }}
        onRetryExport={(item) => {
          /* Plan 82 — re-fire the original export. Reads the wire context
             that the adapter propagated onto the queue row (bookId,
             exportId, wireFormat, wireDestination, syncPath). */
          if (!item.bookId || !item.exportId || !item.wireFormat || !item.wireDestination) return;
          dispatch(
            retryExport({
              bookId: item.bookId,
              exportId: item.exportId,
              format: item.wireFormat,
              destination: item.wireDestination,
              syncPath: item.syncPath,
            }),
          );
        }}
        onDownloadExport={(item) => {
          /* Plan 82 — Download on a `done` row without a signed `url`
             builds the /download URL from bookId + exportId. When `url`
             is present (cloud-mediated downloads), we prefer it. */
          if (item.url) {
            window.location.assign(item.url);
          } else if (item.bookId && item.exportId) {
            window.location.assign(`/api/books/${item.bookId}/exports/${item.exportId}/download`);
          }
        }}
      />

      <ListenMetadataEditor
        bookMeta={bookMeta}
        onEditField={onEditMetaField}
        onCommit={onCommitMeta}
        onCancel={onCancelMeta}
        isDirty={isMetaDirty}
        onReplaceCover={() => openCoverPicker('upload')}
        onRegenerateCover={() => openCoverPicker('search')}
      />

      <ShareLinkModal
        open={shareLink != null}
        url={shareLink?.url ?? null}
        onClose={() => setShareLink(null)}
        onCopyFailed={(reason) =>
          dispatch(
            notificationsActions.pushToast({
              kind: 'warn',
              message: reason
                ? `Couldn't copy link: ${reason}`
                : "Couldn't copy link to clipboard.",
              dedupeKey: 'share-link-copy-failed',
            }),
          )
        }
      />

      <ExportAudiobookModal
        open={exportModal != null}
        bookId={bookId}
        initialTab={exportModal?.tab ?? 'download'}
        prefill={
          exportModal?.appHint === 'voice'
            ? { format: 'm4b', destination: 'sync-folder', appHint: 'voice' }
            : exportModal?.appHint === 'smart_audiobook'
              ? { format: 'mp3-folder', destination: 'sync-folder', appHint: 'smart_audiobook' }
              : exportModal?.appHint === 'bookplayer'
                ? { format: 'mp3-folder', destination: 'sync-folder', appHint: 'bookplayer' }
                : exportModal?.appHint === 'audiobookshelf'
                  ? { format: 'mp3-folder', destination: 'sync-folder', appHint: 'audiobookshelf' }
                  : exportModal?.format
                    ? { format: exportModal.format, destination: exportModal.tab }
                    : undefined
        }
        onClose={() => setExportModal(null)}
      />

      <CoverPicker
        open={coverPickerOpen}
        bookId={bookId}
        bookTitle={title}
        bookAuthor={author}
        currentCoverUrl={effectiveCoverUrl ?? undefined}
        currentFraming={effectiveFraming}
        initialTab={coverPickerInitialTab}
        onClose={() => {
          setCoverPickerOpen(false);
          setCoverPickerInitialTab(undefined);
        }}
        onPicked={(newUrl) => {
          setCoverLoadFailed(false);
          /* Empty string from a "Remove cover" pick — shadow the slice
             with an empty override until the parent refresh hydrates. */
          setCoverOverride(newUrl ? `${newUrl}?t=${Date.now()}` : '');
          /* New image deserves fresh framing — clear local override so
             the prop (which the slice will refresh to default) wins. */
          setFramingOverride(null);
          void onCoverChanged?.();
        }}
        onFramingChanged={(f) => setFramingOverride(f)}
      />
    </div>
  );
}

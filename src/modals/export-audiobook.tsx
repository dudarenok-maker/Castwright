/* Export audiobook modal — entry point for sideloading a finished book
   onto a phone (PocketBook Reader, Smart AudioBook Player, etc.) or
   shovelling it into a synced folder.

   Two tabs:
   - "Download to phone": shows the server's LAN URL + a QR code so the
     user can scan it from their Android phone's camera, hit the link in
     Chrome, and let the browser save the audiobook into Downloads/.
     Tap → Open with → PocketBook Reader.
   - "Save to sync folder": writes the finished archive into a user-
     configured directory (typically OneDrive / Syncthing). The path
     field is bound to userSettings.exportSyncFolder.

   Phase A ships `mp3-zip` only. The submit button kicks off
   `createBookExport`; the modal then polls `getBookExport` every 800ms
   and renders progress via the shared `ExportQueueRow`. On 409
   `export_incomplete` we surface the missing-chapter slug list with a
   "Re-open Generate view" CTA. */

import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import { IconClose, IconDownload, IconExternal } from '../lib/icons';
import { ExportQueueRow } from '../components/export-queue-row';
import { bookExportJobToQueueItem } from '../lib/export-queue-adapter';
import { api, ExportIncompleteError } from '../lib/api';
import { useAppDispatch, useAppSelector } from '../store';
import { exportsActions } from '../store/exports-slice';
import { saveAccountSettings } from '../store/account-slice';
import type { BookExportJob, BookExportRequest } from '../lib/types';

interface Props {
  open: boolean;
  bookId: string;
  /** Optional starting tab — the PocketBook ListenerApp tile opens the
      modal pre-set to the download path since that's the primary
      sideload story on Android. */
  initialTab?: TabId;
  /** Optional per-app specialisation. When `appHint` is set, the modal
      collapses to that app's single supported shape — the format and
      destination toggles are hidden and the submit button copy adapts.
      The generic header pill + non-app-specific entry points pass
      `prefill={undefined}` to keep the full UX. */
  prefill?: ExportPrefill;
  onClose: () => void;
}

export interface ExportPrefill {
  format?: FormatId;
  destination?: TabId;
  /** Per-app key. When the key matches a `TILE_HINTS` entry the modal
      collapses to that tile's single supported shape (format +
      destination forced, toggles hidden, header + submit + body copy
      specialised). Unknown keys fall back to the generic two-tab UX
      with `format` / `destination` still applied as defaults. */
  appHint?: TileHintKey | string;
}

type TabId = 'download' | 'sync-folder';
type FormatId = 'm4b' | 'mp3-zip' | 'mp3-folder';
type TileHintKey = 'voice' | 'smart_audiobook' | 'bookplayer' | 'audiobookshelf';

/* Per-tile specialisation. Adding a new live tile is one entry here +
   the corresponding handler wire-up in `src/views/listen.tsx`. The
   modal then renders the tile-collapsed UX without any new branching.
   The `format`/`destination` fields are the contract the route
   accepts; if the user picks a different export shape the toggles
   surface via the generic two-tab UX (no TILE_HINTS entry).

   Plan 33 (B Voice) seeded this pattern; plan 34 B2-B4 fills in the
   folder-format trio. */
interface TileHint {
  format: FormatId;
  destination: TabId;
  headerTitle: string;
  submitLabel: string;
  footerNote: string;
  bodyIntro: string;
  folderInputLabel: string;
  /** Caption shown above the input when a sync folder is already
      configured. Receives the saved path so the copy can name it. */
  savedCaption: (savedPath: string) => string;
}

const TILE_HINTS: Record<TileHintKey, TileHint> = {
  voice: {
    format: 'm4b',
    destination: 'sync-folder',
    headerTitle: 'Send to Voice library',
    submitLabel: 'Export to Voice library',
    footerNote: 'Voice on the device picks up the new .m4b once your sync folder finishes pushing it.',
    bodyIntro: "Voice scans a folder on your Android device for new audiobooks. Point this at the same folder your sync app (Syncthing, OneDrive, Google Drive desktop) keeps mirrored to the phone — your M4B lands there and Voice picks it up on its next library scan.",
    folderInputLabel: 'Voice library folder',
    savedCaption: (saved) => `Saves to your Voice library at ${saved}.`,
  },
  smart_audiobook: {
    format: 'mp3-folder',
    destination: 'sync-folder',
    headerTitle: 'Send to Smart AudioBook Player',
    submitLabel: 'Export to Smart AudioBook Player',
    footerNote: 'Smart AudioBook Player scans its books folder on the device — the new book appears after your sync app finishes pushing it.',
    bodyIntro: "Smart AudioBook Player reads a folder per book from a configurable books directory on your Android device. Point this at the same folder your sync app mirrors there — the per-chapter MP3s arrive tagged with title, author, and cover art (when one is set).",
    folderInputLabel: 'Smart AudioBook Player books folder',
    savedCaption: (saved) => `Saves to your Smart AudioBook Player books folder at ${saved}.`,
  },
  bookplayer: {
    /* Reserved for B3 — wired here so the type stays exhaustive and the
       handler in listen.tsx can be added in a one-line follow-up. */
    format: 'mp3-folder',
    destination: 'sync-folder',
    headerTitle: 'Send to BookPlayer',
    submitLabel: 'Export for BookPlayer',
    footerNote: 'AirDrop the folder from Finder to your iPhone, then open with BookPlayer. The Files import preserves the chapter order.',
    bodyIntro: "BookPlayer reads a folder per book on iOS via the Files app. Point this at a folder on your Mac that you can AirDrop from — the per-chapter MP3s arrive with tags and cover art ready to import.",
    folderInputLabel: 'BookPlayer staging folder',
    savedCaption: (saved) => `Stages BookPlayer-ready folders at ${saved}.`,
  },
  audiobookshelf: {
    /* Reserved for B4. */
    format: 'mp3-folder',
    destination: 'sync-folder',
    headerTitle: 'Send to Audiobookshelf',
    submitLabel: 'Export to Audiobookshelf library',
    footerNote: 'Audiobookshelf rescans its library on a schedule — the new book appears after the next scan once your sync finishes pushing it.',
    bodyIntro: "Audiobookshelf scans a configured library root on the server and treats each subfolder as one book. Point this at the same folder your sync app mirrors to the server's library path — the chapters arrive tagged and ready.",
    folderInputLabel: 'Audiobookshelf library folder',
    savedCaption: (saved) => `Saves to your Audiobookshelf library at ${saved}.`,
  },
};

function tileHintFor(appHint: string | undefined): TileHint | null {
  if (!appHint) return null;
  return (TILE_HINTS as Record<string, TileHint | undefined>)[appHint] ?? null;
}

export function ExportAudiobookModal({ open, bookId, initialTab = 'download', prefill, onClose }: Props) {
  const dispatch = useAppDispatch();
  const lanUrls = useAppSelector(s => s.exports.lanUrls);
  const account = useAppSelector(s => s.account);
  /* prefill (when set) overrides the initialTab/default-format on open
     and on each open-toggle reset. Tile callers (Voice, Smart AudioBook
     Player, BookPlayer, Audiobookshelf, …) pass `appHint` so the modal
     can drop the format/destination toggles and surface tile-specific
     header/body/submit/footer copy from `TILE_HINTS`. */
  const tileHint = tileHintFor(prefill?.appHint);
  const [tab, setTab] = useState<TabId>(prefill?.destination ?? initialTab);
  const [format, setFormat] = useState<FormatId>(prefill?.format ?? 'm4b');
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [syncFolderDraft, setSyncFolderDraft] = useState(account.exportSyncFolder ?? '');
  const [syncFolderSaving, setSyncFolderSaving] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  /* Hydrate LAN URLs once when the modal opens — they don't change without
     a server restart, so we keep the value cached on the slice. */
  useEffect(() => {
    if (!open) return;
    if (lanUrls.length > 0) return;
    let cancelled = false;
    api.getExportLanUrls().then(info => {
      if (!cancelled) dispatch(exportsActions.lanUrlsHydrated(info));
    }).catch(() => { /* swallow — modal still renders, just without a URL */ });
    return () => { cancelled = true; };
  }, [open, lanUrls.length, dispatch]);

  /* Reset transient UI state on close so the next open is a clean slate.
     Prefill (when set) overrides the per-open defaults — so the Voice tile
     reopening the modal lands on M4B + sync-folder regardless of what the
     previous open left selected. */
  useEffect(() => {
    if (open) {
      setTab(prefill?.destination ?? initialTab);
      setFormat(prefill?.format ?? 'm4b');
      setActiveJobId(null);
      setMissing(null);
      setSubmitting(false);
      setSyncFolderDraft(account.exportSyncFolder ?? '');
    }
  }, [open, initialTab, prefill?.destination, prefill?.format, account.exportSyncFolder]);

  /* QR render of the first LAN URL. Stays null until both the URL and
     the tab agree it's worth drawing. */
  useEffect(() => {
    const url = lanUrls[0];
    if (!open || tab !== 'download' || !url) { setQrDataUrl(null); return; }
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, scale: 6 }).then(dataUrl => {
      if (!cancelled) setQrDataUrl(dataUrl);
    }).catch(() => { /* fall back to text URL */ });
    return () => { cancelled = true; };
  }, [open, tab, lanUrls]);

  /* Poll the active job until terminal. */
  const pollHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await api.getBookExport(bookId, activeJobId);
        if (cancelled) return;
        dispatch(exportsActions.exportUpdated(job));
        if (job.status === 'in_progress' || job.status === 'queued') {
          pollHandle.current = setTimeout(tick, 800);
        }
      } catch { /* keep modal open; user can dismiss manually */ }
    };
    pollHandle.current = setTimeout(tick, 400);
    return () => {
      cancelled = true;
      if (pollHandle.current) clearTimeout(pollHandle.current);
    };
  }, [activeJobId, bookId, dispatch]);

  /* Hook must run on every render — keep it above the early return. */
  const activeJob: BookExportJob | undefined = useAppSelector(s =>
    activeJobId ? (s.exports.byBookId[bookId] ?? []).find(j => j.id === activeJobId) : undefined,
  );

  if (!open) return null;

  const handleSubmit = async () => {
    setMissing(null);
    setSubmitting(true);
    try {
      const body: BookExportRequest = {
        format,
        destination: tab === 'sync-folder' ? 'sync-folder' : 'download',
      };
      const job = await api.createBookExport(bookId, body);
      dispatch(exportsActions.exportStarted(job));
      setActiveJobId(job.id);
    } catch (e) {
      if (e instanceof ExportIncompleteError) {
        setMissing(e.missing);
      } else {
        setMissing([(e as Error).message]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleSaveSyncFolder = async () => {
    setSyncFolderSaving(true);
    try {
      await dispatch(saveAccountSettings({ exportSyncFolder: syncFolderDraft.trim() || null }));
    } finally {
      setSyncFolderSaving(false);
    }
  };

  const lanUrl = lanUrls[0] ?? null;
  const syncFolder = account.exportSyncFolder ?? null;
  const canSubmit = !submitting && (
    tab === 'download'
      ? lanUrl != null
      : syncFolder != null && syncFolder.length > 0
  );

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in"/>
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto fade-in overflow-hidden"
             data-testid="export-audiobook-modal">
          <header className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full grid place-items-center shrink-0 bg-peach/15 text-magenta">
              <IconDownload className="w-4 h-4"/>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Export audiobook</p>
              <h3 className="text-base font-bold text-ink truncate">
                {tileHint?.headerTitle ?? 'Sideload to your phone or sync folder'}
              </h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60" aria-label="Close">
              <IconClose className="w-4 h-4"/>
            </button>
          </header>

          {!tileHint && (
            <div className="px-6 pt-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-1 bg-ink/[0.04] rounded-full p-0.5 text-xs">
                {([
                  { id: 'download',     label: 'Download to phone' },
                  { id: 'sync-folder',  label: 'Save to sync folder' },
                ] as Array<{ id: TabId; label: string }>).map(t => (
                  <button key={t.id}
                          data-testid={`export-tab-${t.id}`}
                          onClick={() => setTab(t.id)}
                          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${tab === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Format</span>
                <div className="flex items-center gap-1 bg-ink/[0.04] rounded-full p-0.5 text-xs">
                  {([
                    { id: 'm4b',     label: 'M4B' },
                    { id: 'mp3-zip', label: 'MP3.ZIP' },
                  ] as Array<{ id: FormatId; label: string }>).map(f => (
                    <button key={f.id}
                            data-testid={`export-format-${f.id}`}
                            onClick={() => setFormat(f.id)}
                            className={`px-3 py-1.5 rounded-full font-medium transition-colors ${format === f.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}>
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed">
            {tileHint ? (
              <TileBody
                hint={tileHint}
                hintKey={prefill?.appHint as string}
                draft={syncFolderDraft}
                setDraft={setSyncFolderDraft}
                saved={syncFolder}
                saving={syncFolderSaving}
                onSave={handleSaveSyncFolder}
              />
            ) : tab === 'download' ? (
              <DownloadTab url={lanUrl} qrDataUrl={qrDataUrl}/>
            ) : (
              <SyncFolderTab
                draft={syncFolderDraft}
                setDraft={setSyncFolderDraft}
                saved={syncFolder}
                saving={syncFolderSaving}
                onSave={handleSaveSyncFolder}
              />
            )}

            {missing && missing.length > 0 && (
              <div data-testid="export-missing-banner"
                   className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-rose-800">
                <p className="font-semibold text-sm">Some chapters still need audio.</p>
                <ul className="mt-1 text-xs list-disc list-inside">
                  {missing.slice(0, 6).map(slug => <li key={slug}>{slug}</li>)}
                  {missing.length > 6 && <li>… and {missing.length - 6} more.</li>}
                </ul>
                <p className="mt-2 text-xs">
                  Generate those chapters from the Generate view, then try the export again.
                </p>
              </div>
            )}

            {activeJob && (
              <div className="mt-5 bg-canvas rounded-2xl border border-ink/10 overflow-hidden"
                   data-testid="export-active-job">
                <ExportQueueRow
                  item={bookExportJobToQueueItem(activeJob)}
                  onDownload={() => { if (activeJob.downloadUrl) window.location.assign(activeJob.downloadUrl); }}
                />
              </div>
            )}
          </div>

          <footer className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <p className="text-xs text-ink/55">
              {tileHint
                ? tileHint.footerNote
                : format === 'm4b'
                  ? 'M4B: one file, chapter markers, resumes where you stop. PocketBook lists it under Audiobooks.'
                  : format === 'mp3-zip'
                    ? 'MP3.ZIP: a folder of tagged MP3s. Universal compatibility; any audiobook app reads it.'
                    : 'MP3 folder: per-chapter tagged MP3s mirrored into your sync folder. Folder-scanning apps pick them up.'}
            </p>
            <div className="flex items-center gap-3">
              <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">Close</button>
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                data-testid="export-submit"
                className="px-5 py-2 rounded-full font-semibold text-sm bg-ink text-canvas hover:bg-ink-soft disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting
                  ? 'Starting…'
                  : tileHint
                    ? tileHint.submitLabel
                    : (tab === 'download' ? 'Build download' : 'Build and save')}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </>
  );
}

function DownloadTab({ url, qrDataUrl }: { url: string | null; qrDataUrl: string | null }) {
  if (!url) {
    return (
      <p>
        The server doesn't currently see a LAN-routable IP. Make sure your PC and phone are on
        the same Wi-Fi, then re-open this modal.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[1fr_180px] gap-5 items-center">
      <div>
        <p>
          Open the link below in Chrome on your Android phone, then tap the downloaded file and
          choose <strong>Open with PocketBook Reader</strong>. The audiobook arrives with chapter
          markers and title/author tags already in place.
        </p>
        <div className="mt-3 inline-flex items-center gap-2 px-3 py-2 rounded-full bg-canvas border border-ink/10 text-sm font-mono">
          <a href={url} target="_blank" rel="noreferrer" className="text-ink hover:underline">{url}</a>
          <IconExternal className="w-3.5 h-3.5 text-ink/50"/>
        </div>
        <p className="mt-3 text-xs text-ink/55">
          The "Build download" button below stages a zip on the server, then the link above takes you to it.
        </p>
      </div>
      <div className="flex justify-end">
        {qrDataUrl
          ? <img src={qrDataUrl} alt="LAN URL QR code" className="w-[160px] h-[160px] rounded-xl border border-ink/10 bg-white p-1"/>
          : <div className="w-[160px] h-[160px] rounded-xl border border-dashed border-ink/15 grid place-items-center text-xs text-ink/40">QR…</div>}
      </div>
    </div>
  );
}

interface SyncFolderTabProps {
  draft: string;
  setDraft: (next: string) => void;
  saved: string | null;
  saving: boolean;
  onSave: () => void;
}
function SyncFolderTab({ draft, setDraft, saved, saving, onSave }: SyncFolderTabProps) {
  const isDirty = (saved ?? '') !== draft;
  return (
    <div className="space-y-3">
      <p>
        Set a folder your phone keeps in sync (OneDrive, Syncthing, Google Drive desktop). The
        finished archive lands there and your phone picks it up automatically.
      </p>
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Sync folder</span>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="C:\Users\you\OneDrive\Audiobooks"
          className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30 font-mono"
          aria-label="Sync folder"
          data-testid="sync-folder-input"
        />
      </label>
      <div className="flex items-center justify-end">
        <button
          onClick={onSave}
          disabled={!isDirty || saving}
          className="text-xs font-semibold px-3 py-1.5 rounded-full bg-ink/[0.04] text-ink hover:bg-ink/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : isDirty ? 'Save folder' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

/* Per-tile body shared across every TILE_HINTS entry. The user sets
   their tile-specific folder once (lives on
   userSettings.exportSyncFolder, shared across tiles — only one synced
   folder per user makes sense) and re-uses it across exports. Format +
   destination toggles are hidden by the parent on tile mode; this body
   is the only interactive surface.

   Tile copy comes from TILE_HINTS; the layout is shared. Each tile
   gets its own `export-tile-body-<hintKey>` / `export-tile-caption-<hintKey>`
   testids so a spec can target one tile without false positives across
   the others. The Voice tile retains its plan-33 `export-voice-body` /
   `export-voice-caption` testids as aliases so the existing spec
   doesn't churn for a refactor. */
interface TileBodyProps extends SyncFolderTabProps {
  hint: TileHint;
  hintKey: string;
}
function TileBody({ hint, hintKey, draft, setDraft, saved, saving, onSave }: TileBodyProps) {
  const isDirty = (saved ?? '') !== draft;
  const bodyTestId    = hintKey === 'voice' ? 'export-voice-body'    : `export-tile-body-${hintKey}`;
  const captionTestId = hintKey === 'voice' ? 'export-voice-caption' : `export-tile-caption-${hintKey}`;
  return (
    <div className="space-y-3" data-testid={bodyTestId}>
      <p>{hint.bodyIntro}</p>
      {saved && !isDirty ? (
        <p className="text-xs text-ink/55" data-testid={captionTestId}>
          {hint.savedCaption(saved)}
        </p>
      ) : null}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">{hint.folderInputLabel}</span>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="C:\Users\you\OneDrive\Audiobooks"
          className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30 font-mono"
          aria-label={hint.folderInputLabel}
          data-testid="sync-folder-input"
        />
      </label>
      <div className="flex items-center justify-end">
        <button
          onClick={onSave}
          disabled={!isDirty || saving}
          className="text-xs font-semibold px-3 py-1.5 rounded-full bg-ink/[0.04] text-ink hover:bg-ink/[0.08] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : isDirty ? 'Save folder' : 'Saved'}
        </button>
      </div>
    </div>
  );
}

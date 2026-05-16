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
  /** Per-app key. Today only `'voice'` triggers a specialised UX (M4B +
      sync-folder forced); other values fall back to the generic flow
      with the format/destination still applied as defaults. */
  appHint?: 'voice' | 'pocketbook' | string;
}

type TabId = 'download' | 'sync-folder';
type FormatId = 'm4b' | 'mp3-zip';

export function ExportAudiobookModal({ open, bookId, initialTab = 'download', prefill, onClose }: Props) {
  const dispatch = useAppDispatch();
  const lanUrls = useAppSelector(s => s.exports.lanUrls);
  const account = useAppSelector(s => s.account);
  /* prefill (when set) overrides the initialTab/default-format on open and
     on each open-toggle reset. Voice tile callers pass
     `{ format: 'm4b', destination: 'sync-folder', appHint: 'voice' }` so
     the modal opens with the right shape and the appHint branch can
     collapse the format/destination toggles. */
  const isVoice = prefill?.appHint === 'voice';
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
                {isVoice ? 'Send to Voice library' : 'Sideload to your phone or sync folder'}
              </h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60" aria-label="Close">
              <IconClose className="w-4 h-4"/>
            </button>
          </header>

          {!isVoice && (
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
            {isVoice ? (
              <VoiceTab
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
              {isVoice
                ? 'Voice on the device picks up the new .m4b once your sync folder finishes pushing it.'
                : format === 'm4b'
                  ? 'M4B: one file, chapter markers, resumes where you stop. PocketBook lists it under Audiobooks.'
                  : 'MP3.ZIP: a folder of tagged MP3s. Universal compatibility; any audiobook app reads it.'}
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
                  : isVoice
                    ? 'Export to Voice library'
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

/* Voice-specialised body. Same SyncFolderTab interaction (the user sets
   their Voice library folder once, then re-uses it across exports) but
   with copy that names the Voice flow directly and a caption surfacing
   the saved path when one is configured. Format and destination toggles
   are hidden by the parent — Voice's contract is M4B + sync-folder, full
   stop. */
function VoiceTab({ draft, setDraft, saved, saving, onSave }: SyncFolderTabProps) {
  const isDirty = (saved ?? '') !== draft;
  return (
    <div className="space-y-3" data-testid="export-voice-body">
      <p>
        Voice scans a folder on your Android device for new audiobooks. Point this at the same
        folder your sync app (Syncthing, OneDrive, Google Drive desktop) keeps mirrored to the
        phone — your M4B lands there and Voice picks it up on its next library scan.
      </p>
      {saved && !isDirty ? (
        <p className="text-xs text-ink/55" data-testid="export-voice-caption">
          Saves to your Voice library at <span className="font-mono text-ink/80">{saved}</span>.
        </p>
      ) : null}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">Voice library folder</span>
        <input
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="C:\Users\you\OneDrive\Audiobooks"
          className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30 font-mono"
          aria-label="Voice library folder"
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

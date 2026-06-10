/* CoverPicker modal — three tabs (plan 40).

   Search (the original): OpenLibrary candidate grid.
   Upload: drag-drop / file picker for JPEG/PNG (server transcodes PNG → JPEG).
   Frame:  square preview with drag-pan + zoom slider (debounced PATCH).

   The initial tab honours the user's `coverPickerDefaultTab` account
   setting; Frame is always disabled until a cover is pinned. Successful
   uploads auto-switch to Frame so the user can immediately reframe
   their new image (it's the next action 90% of the time). */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconClose, IconImage, IconRefresh } from '../lib/icons';
import { api, UploadCoverError } from '../lib/api';
import { useAppSelector } from '../store';
import type { CoverCandidate } from '../lib/types';
import {
  type CoverFraming,
  DEFAULT_FRAMING,
  clampFraming,
  computeCoverStyle,
} from '../lib/cover-framing';

interface Props {
  open: boolean;
  bookId: string;
  bookTitle: string;
  bookAuthor: string;
  /** Currently-selected cover URL (server-relative). When present, the
      Frame tab is enabled and the modal renders a Remove cover button. */
  currentCoverUrl?: string;
  /** Currently-saved framing (from `LibraryBook.coverFraming`). Seeds the
      Frame tab's controls; absent → DEFAULT_FRAMING. */
  currentFraming?: CoverFraming;
  onClose: () => void;
  /** Fires after pick / upload / remove. Empty string means "the user
      removed the cover". Parent should refresh the library so cards +
      Listen header repaint. */
  onPicked: (coverImageUrl: string) => void;
  /** Optional — fires after a successful framing PATCH so the parent can
      update its local LibraryBook.coverFraming for instant feedback in
      other surfaces (BookCard, CoverArt) without re-fetching. */
  onFramingChanged?: (framing: CoverFraming) => void;
  /** Optional one-shot tab override applied each time `open` flips true.
      Beats the account-default for that opening only; the user can still
      switch tabs once the modal is mounted. Used by the Listen view to
      route the metadata-editor "Replace" button → Upload tab and
      "Regenerate" button → Search tab. */
  initialTab?: 'search' | 'upload';
}

type TabKey = 'search' | 'upload' | 'frame';

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; candidates: CoverCandidate[] }
  | { kind: 'error'; message: string };

const ACCEPTED_MIME = ['image/jpeg', 'image/png'] as const;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_UPLOAD_MB = 10;
const FRAMING_DEBOUNCE_MS = 300;

const SOURCE_LABEL: Record<CoverCandidate['source'], string> = {
  openlibrary: 'OpenLibrary',
  apple: 'Apple',
  google: 'Google',
};

export function CoverPicker(props: Props) {
  const {
    open,
    bookId,
    bookTitle,
    bookAuthor,
    currentCoverUrl,
    currentFraming,
    onClose,
    onPicked,
    onFramingChanged,
    initialTab,
  } = props;

  const accountDefaultTab = useAppSelector((s) => s.account.coverPickerDefaultTab ?? 'search');
  const [tab, setTab] = useState<TabKey>(
    initialTab ?? (accountDefaultTab === 'upload' ? 'upload' : 'search'),
  );

  /* When the modal re-opens with a different initialTab override (e.g.
     Replace vs Regenerate buttons in the metadata editor), honour the
     fresh override on each open. Once the modal is mounted the user can
     still switch tabs freely. */
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current && initialTab) {
      setTab(initialTab);
    }
    prevOpen.current = open;
  }, [open, initialTab]);

  /* Search-tab state */
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [submitting, setSubmitting] = useState<string | null>(null);

  /* Upload-tab state */
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  /* Effective cover URL — starts from prop, updated locally on upload so
     the Frame tab can render the just-uploaded image without waiting for
     the parent to refresh. Cache-bust via ?t= on update so the browser
     fetches new bytes from the same path. */
  const [liveCoverUrl, setLiveCoverUrl] = useState<string | undefined>(currentCoverUrl);

  /* Frame-tab state. Initialise from prop; PATCH debounced. */
  const [framing, setFraming] = useState<CoverFraming>(currentFraming ?? DEFAULT_FRAMING);
  const framingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [removing, setRemoving] = useState(false);

  /* Re-sync local state whenever the modal opens or props change. */
  useEffect(() => {
    if (open) {
      setSubmitting(null);
      setRemoving(false);
      setUploadError(null);
      setUploading(false);
      setTab(accountDefaultTab === 'upload' ? 'upload' : 'search');
      setLiveCoverUrl(currentCoverUrl);
      setFraming(currentFraming ?? DEFAULT_FRAMING);
      void loadCandidates();
    } else {
      setState({ kind: 'idle' });
      if (framingTimer.current) {
        clearTimeout(framingTimer.current);
        framingTimer.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const loadCandidates = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const { candidates } = await api.findCoverCandidates(bookId);
      setState({ kind: 'ready', candidates });
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message || 'Failed to load covers.' });
    }
  }, [bookId]);

  if (!open) return null;

  async function pickFromSearch(candidate: CoverCandidate) {
    setSubmitting(candidate.id);
    try {
      const { coverImageUrl } = await api.setCover(bookId, candidate.id);
      onPicked(coverImageUrl);
      onClose();
    } catch (e) {
      setSubmitting(null);
      setState({ kind: 'error', message: (e as Error).message || 'Failed to save cover.' });
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api.removeCover(bookId);
      onPicked('');
      onClose();
    } catch (e) {
      setRemoving(false);
      setState({ kind: 'error', message: (e as Error).message || 'Failed to remove cover.' });
    }
  }

  async function handleUpload(file: File) {
    setUploadError(null);
    /* Client-side pre-validation. Server is still source of truth, but
       failing here saves a multipart round-trip on the obvious cases. */
    if (!(ACCEPTED_MIME as readonly string[]).includes(file.type)) {
      setUploadError('Only JPEG and PNG covers are supported.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setUploadError(`Cover must be under ${MAX_UPLOAD_MB} MB.`);
      return;
    }
    setUploading(true);
    try {
      const { coverImageUrl } = await api.uploadCover(bookId, file);
      const busted = `${coverImageUrl}?t=${Date.now()}`;
      setLiveCoverUrl(busted);
      /* Fresh image deserves a fresh frame (server already reset
         coverImage.framing — mirror locally). */
      setFraming(DEFAULT_FRAMING);
      onPicked(coverImageUrl);
      setTab('frame');
    } catch (e) {
      const msg =
        e instanceof UploadCoverError ? e.message : (e as Error).message || 'Cover upload failed.';
      setUploadError(msg);
    } finally {
      setUploading(false);
    }
  }

  function scheduleFramingPatch(next: CoverFraming) {
    if (framingTimer.current) clearTimeout(framingTimer.current);
    framingTimer.current = setTimeout(() => {
      void api
        .patchCoverFraming(bookId, next)
        .then(() => {
          onFramingChanged?.(next);
        })
        .catch(() => {
          /* Swallow — framing is a polish op; failures don't get a banner. */
        });
    }, FRAMING_DEBOUNCE_MS);
  }

  function updateFraming(next: CoverFraming) {
    const clamped = clampFraming(next);
    setFraming(clamped);
    scheduleFramingPatch(clamped);
  }

  function resetFraming() {
    updateFraming(DEFAULT_FRAMING);
  }

  const busy = submitting !== null || removing || uploading;
  const hasCover = !!liveCoverUrl;

  return (
    <>
      <div onClick={busy ? undefined : onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          data-testid="cover-picker"
          className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto fade-in overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta shrink-0">
              <IconImage className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Cover image
              </p>
              <h3 className="text-base font-bold text-ink truncate">{bookTitle}</h3>
            </div>
            <button
              onClick={onClose}
              disabled={busy}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 disabled:opacity-40 disabled:cursor-not-allowed"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div
            role="tablist"
            aria-label="Cover picker tabs"
            className="px-6 pt-3 border-b border-ink/10 flex items-center gap-1 text-sm"
          >
            <TabButton
              id="tab-search"
              active={tab === 'search'}
              onClick={() => setTab('search')}
              disabled={busy}
            >
              Search OpenLibrary
            </TabButton>
            <TabButton
              id="tab-upload"
              active={tab === 'upload'}
              onClick={() => setTab('upload')}
              disabled={busy}
            >
              Upload
            </TabButton>
            <TabButton
              id="tab-frame"
              active={tab === 'frame'}
              onClick={() => setTab('frame')}
              disabled={busy || !hasCover}
            >
              Frame
            </TabButton>
          </div>

          <div className="px-6 py-5">
            {tab === 'search' && (
              <SearchPanel
                state={state}
                bookTitle={bookTitle}
                bookAuthor={bookAuthor}
                busy={busy}
                submitting={submitting}
                onPick={(c) => void pickFromSearch(c)}
                onRetry={() => void loadCandidates()}
              />
            )}
            {tab === 'upload' && (
              <UploadPanel
                uploading={uploading}
                error={uploadError}
                onPick={(f) => void handleUpload(f)}
              />
            )}
            {tab === 'frame' && hasCover && liveCoverUrl && (
              <FramePanel
                coverUrl={liveCoverUrl}
                framing={framing}
                onChange={updateFraming}
                onReset={resetFraming}
              />
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3 flex-wrap">
            <p className="text-[11px] text-ink/50">
              {tab === 'search' && (
                <>
                  Covers from{' '}
                  <a
                    className="underline"
                    href="https://openlibrary.org"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenLibrary
                  </a>
                  , Apple Books &amp; Google Books. Click a cover to use it.
                </>
              )}
              {tab === 'upload' && (
                <>JPEG or PNG, up to {MAX_UPLOAD_MB} MB. PNGs are converted to JPEG.</>
              )}
              {tab === 'frame' && <>Drag and zoom to reframe. Saves automatically.</>}
            </p>
            <div className="flex items-center gap-3">
              {currentCoverUrl && (
                <button
                  onClick={() => void remove()}
                  disabled={busy}
                  className="text-sm font-medium text-red-700 hover:text-red-800 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Remove cover
                </button>
              )}
              <button
                onClick={onClose}
                disabled={busy}
                className="text-sm font-medium text-ink/60 hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function TabButton({
  id,
  active,
  disabled,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      id={id}
      role="tab"
      aria-selected={active}
      data-testid={id}
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-2 border-b-2 -mb-px font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${active ? 'border-magenta text-ink' : 'border-transparent text-ink/55 hover:text-ink'}`}
    >
      {children}
    </button>
  );
}

function SearchPanel({
  state,
  bookTitle,
  bookAuthor,
  busy,
  submitting,
  onPick,
  onRetry,
}: {
  state: LoadState;
  bookTitle: string;
  bookAuthor: string;
  busy: boolean;
  submitting: string | null;
  onPick: (c: CoverCandidate) => void;
  onRetry: () => void;
}) {
  return (
    <>
      {state.kind === 'loading' && <CoverGridSkeleton />}
      {state.kind === 'error' && (
        <div className="py-6 text-center">
          <p className="text-sm text-red-700 mb-4">{state.message}</p>
          <button
            onClick={onRetry}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/15 bg-white text-sm font-medium text-ink hover:bg-ink/4"
          >
            <IconRefresh className="w-4 h-4" /> Try again
          </button>
        </div>
      )}
      {state.kind === 'ready' && state.candidates.length === 0 && (
        <p className="py-10 text-center text-sm text-ink/60">
          No covers found for <span className="font-semibold text-ink">{bookTitle}</span>
          {bookAuthor ? (
            <>
              {' '}
              by <span className="font-semibold text-ink">{bookAuthor}</span>
            </>
          ) : null}{' '}
          across OpenLibrary, Apple Books, and Google Books.
        </p>
      )}
      {state.kind === 'ready' && state.candidates.length > 0 && (
        <div data-testid="cover-grid" className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {state.candidates.map((c) => (
            <button
              key={c.id}
              data-testid={`cover-candidate-${c.id}`}
              onClick={() => onPick(c)}
              disabled={busy}
              className={`group relative rounded-2xl overflow-hidden border bg-canvas aspect-2/3 focus:outline-hidden transition-shadow ${submitting === c.id ? 'border-magenta ring-2 ring-magenta/30' : 'border-ink/10 hover:shadow-card hover:border-ink/20'} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <img
                src={c.coverUrl}
                alt={c.edition ? `${bookTitle} — ${c.edition}` : bookTitle}
                className="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
              />
              <span
                data-testid={`cover-source-${c.id}`}
                className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-ink/70 text-white text-[9px] font-semibold uppercase tracking-wide"
              >
                {SOURCE_LABEL[c.source]}
              </span>
              {c.edition && (
                <span className="absolute bottom-0 inset-x-0 px-2 py-1 bg-ink/70 text-white text-[10px] leading-tight truncate">
                  {c.edition}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function UploadPanel({
  uploading,
  error,
  onPick,
}: {
  uploading: boolean;
  error: string | null;
  onPick: (f: File) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="py-2">
      <div
        data-testid="upload-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onPick(f);
        }}
        className={`relative rounded-2xl border-2 border-dashed py-12 px-6 text-center transition-colors ${dragOver ? 'border-magenta bg-magenta/4' : 'border-ink/15 bg-canvas'} ${uploading ? 'opacity-70 pointer-events-none' : ''}`}
      >
        <IconImage className="w-8 h-8 mx-auto text-ink/30" />
        <p className="mt-3 text-sm text-ink/70">Drag and drop a cover image here, or</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-full border border-ink/20 bg-white text-sm font-semibold text-ink hover:bg-ink/4 disabled:opacity-50"
        >
          {uploading ? 'Uploading…' : 'Choose file'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          data-testid="upload-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPick(f);
            /* Reset so the same file can be re-picked after an error. */
            e.target.value = '';
          }}
        />
        <p className="mt-3 text-[11px] text-ink/45">JPEG or PNG · max {MAX_UPLOAD_MB} MB</p>
      </div>
      {error && (
        <p data-testid="upload-error" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function FramePanel({
  coverUrl,
  framing,
  onChange,
  onReset,
}: {
  coverUrl: string;
  framing: CoverFraming;
  onChange: (f: CoverFraming) => void;
  onReset: () => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const dragStart = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

  const style = useMemo(() => computeCoverStyle(framing), [framing]);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const box = boxRef.current;
    if (!box) return;
    box.setPointerCapture(e.pointerId);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: framing.offsetX,
      offsetY: framing.offsetY,
    };
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const start = dragStart.current;
    const box = boxRef.current;
    if (!start || !box) return;
    const rect = box.getBoundingClientRect();
    /* Drag one container-width left → offsetX shifts +100 (image moves
       right by showing the right edge). Sign is intentionally inverted
       so the gesture matches the user's expectation: drag the image
       up to see the bottom. */
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const offsetX = start.offsetX - (dx / rect.width) * 100;
    const offsetY = start.offsetY - (dy / rect.height) * 100;
    onChange({ offsetX, offsetY, zoom: framing.zoom });
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const box = boxRef.current;
    if (box && box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId);
    dragStart.current = null;
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-5 items-start">
        <div
          ref={boxRef}
          data-testid="frame-preview"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative aspect-square w-full max-w-sm rounded-2xl overflow-hidden bg-canvas border border-ink/10 cursor-grab active:cursor-grabbing select-none touch-none"
        >
          <img
            src={coverUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none"
            style={style}
          />
        </div>
        <div className="flex sm:flex-col gap-3 items-start text-sm">
          <label className="block w-full">
            <span className="block text-[11px] font-semibold uppercase tracking-widest text-ink/55">
              Zoom · {framing.zoom.toFixed(2)}×
            </span>
            <input
              data-testid="frame-zoom"
              type="range"
              min={1}
              max={3}
              step={0.05}
              value={framing.zoom}
              onChange={(e) => onChange({ ...framing, zoom: Number(e.target.value) })}
              className="mt-2 w-full accent-magenta"
            />
          </label>
          <button
            type="button"
            data-testid="frame-reset"
            onClick={onReset}
            className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs font-semibold text-ink hover:bg-ink/4"
          >
            Reset framing
          </button>
        </div>
      </div>
    </div>
  );
}

function CoverGridSkeleton() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="rounded-2xl bg-ink/6 aspect-2/3 pulse-bar" />
      ))}
    </div>
  );
}

/* Share-clip modal — plan 69.

   Lets the user pick a [start, end] sub-range of a chapter (default
   ±15 s around the current playhead, capped at 60 s of total
   duration), then confirms to trigger a server-side slice download
   from `GET /api/books/:bookId/chapters/:chapterId/clip`.

   No actual <input type="range"> drag-handle UX yet (Vitest+jsdom
   doesn't simulate pointer-events well, and the e2e harness covers
   the visible-button case). The "range" is two number-ish inputs:
   Start and End, each rendered as a styled mm:ss text input that
   parses on blur, with +/- step buttons in 5 s increments. End is
   clamped to start+60 and to the chapter duration; start is clamped
   to 0 and to end-1.

   On confirm we open the slice as a download via an `<a download>`
   click on a temporarily-created anchor — that flow works even
   inside a same-origin Vite dev server without a content-disposition
   redirect dance. The server stamps `Content-Disposition: attachment`
   regardless. */

import { useEffect, useMemo, useState } from 'react';
import { IconShare, IconClose } from '../lib/icons';
import { formatTime } from '../lib/time';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { MADE_WITH, DOMAIN } from '../lib/brand';
import type { Chapter } from '../lib/types';

/** Server-enforced cap. Mirrored here so the slider widgets clamp
    before they hit the wire. */
export const MAX_CLIP_DURATION_SEC = 60;

/** Default window around the playhead. ±15 s == 30 s clip, which is
    the BACKLOG-spec'd default. */
export const DEFAULT_CLIP_HALF_WINDOW_SEC = 15;

interface ShareClipModalProps {
  open: boolean;
  bookId: string;
  chapter: Chapter | null;
  /** Current playhead in seconds. Used as the centre of the default
      ±15 s window. Falls back to chapter-midpoint when null/undefined
      (e.g. user clicks Share clip without ever pressing Play). */
  playheadSec: number | null;
  /** Chapter duration in seconds. Caps the End handle. */
  durationSec: number;
  onClose: () => void;
  /** Optional injection point for the download trigger so tests
      can assert the right URL without driving `window.location` or
      `document.createElement('a').click()` in jsdom. Defaults to the
      production-grade anchor-click flow when omitted. */
  onDownload?: (url: string) => void;
}

/** Convert a number-like input string ("1:20", "80", "1.5") into a
    seconds value, or NaN if unparseable. */
function parseTime(value: string): number {
  if (!value) return NaN;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  const m = trimmed.match(/^(\d+):([0-5]?\d)(?:\.(\d+))?$/);
  if (!m) return NaN;
  const mins = Number(m[1]);
  const secs = Number(m[2]);
  const frac = m[3] ? Number(`0.${m[3]}`) : 0;
  return mins * 60 + secs + frac;
}

function defaultDownload(url: string) {
  /* Anchor-click flow — works in every modern browser, doesn't
     require pop-up permissions, and the server's
     Content-Disposition: attachment header drives the actual save. */
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ShareClipModal({
  open,
  bookId,
  chapter,
  playheadSec,
  durationSec,
  onClose,
  onDownload,
}: ShareClipModalProps) {
  /* Default window: ±15 s around the playhead, clamped to
     [0, durationSec]. When the playhead is null (no play yet) we
     centre on the chapter midpoint so the slider opens somewhere
     reasonable. */
  const initial = useMemo(() => {
    const safeDuration = Math.max(0, durationSec);
    const centre =
      typeof playheadSec === 'number' && Number.isFinite(playheadSec)
        ? Math.min(Math.max(0, playheadSec), safeDuration)
        : safeDuration / 2;
    const halfWindow = Math.min(
      DEFAULT_CLIP_HALF_WINDOW_SEC,
      Math.max(1, safeDuration / 2),
    );
    const start = Math.max(0, centre - halfWindow);
    let end = Math.min(safeDuration, centre + halfWindow);
    /* On a very short chapter the ±15 clamp can collapse below the
       cap, so just lock end to start+30 / start+duration when needed. */
    if (end - start < 1) end = Math.min(safeDuration, start + 1);
    if (end - start > MAX_CLIP_DURATION_SEC) end = start + MAX_CLIP_DURATION_SEC;
    return { start, end };
  }, [playheadSec, durationSec]);

  const [startSec, setStartSec] = useState<number>(initial.start);
  const [endSec, setEndSec] = useState<number>(initial.end);

  /* Reset whenever the modal re-opens for a new chapter / playhead. */
  useEffect(() => {
    if (open) {
      setStartSec(initial.start);
      setEndSec(initial.end);
    }
  }, [open, initial.start, initial.end]);

  if (!open || !chapter) return null;

  const safeDuration = Math.max(0, durationSec);
  const clipDuration = Math.max(0, endSec - startSec);

  const clampStart = (next: number): number => {
    const upperBound = Math.max(0, Math.min(safeDuration, endSec - 1));
    return Math.max(0, Math.min(upperBound, next));
  };
  const clampEnd = (next: number, anchorStart: number = startSec): number => {
    const lowerBound = anchorStart + 1;
    const cap = Math.min(safeDuration, anchorStart + MAX_CLIP_DURATION_SEC);
    return Math.max(lowerBound, Math.min(cap, next));
  };

  const adjustStart = (delta: number) => setStartSec((s) => clampStart(s + delta));
  const adjustEnd = (delta: number) => setEndSec((e) => clampEnd(e + delta));

  const onStartInput = (value: string) => {
    const parsed = parseTime(value);
    if (Number.isFinite(parsed)) setStartSec(clampStart(parsed));
  };
  const onEndInput = (value: string) => {
    const parsed = parseTime(value);
    if (Number.isFinite(parsed)) setEndSec(clampEnd(parsed));
  };

  /* Range-slider track: thumb1 = start (0..end-1), thumb2 = end (start+1..duration).
     Two stacked sliders that share the same value space. */
  const onStartRange = (value: number) => setStartSec(clampStart(value));
  const onEndRange = (value: number) => setEndSec(clampEnd(value));

  const overCap = clipDuration > MAX_CLIP_DURATION_SEC;
  const tooShort = clipDuration < 1;
  const invalid = overCap || tooShort;

  const handleConfirm = () => {
    if (invalid) return;
    const params = new URLSearchParams({
      start: String(Math.max(0, startSec).toFixed(2)),
      duration: String(Math.min(MAX_CLIP_DURATION_SEC, clipDuration).toFixed(2)),
    });
    const url = `/api/books/${encodeURIComponent(bookId)}/chapters/${chapter.id}/clip?${params.toString()}`;
    (onDownload ?? defaultDownload)(url);
    onClose();
  };

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="share-clip-backdrop"
      />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          data-testid="share-clip-modal"
          className="bg-white rounded-3xl shadow-float w-full max-w-xl pointer-events-auto fade-in overflow-hidden"
        >
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconShare className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Share clip
              </p>
              <h3 className="text-base font-bold text-ink truncate">
                CH {String(chapter.id).padStart(2, '0')} · {stripChapterPrefix(chapter.title)}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 text-sm text-ink/75 leading-relaxed space-y-5">
            <p>
              Pick a section of this chapter (up to {MAX_CLIP_DURATION_SEC} seconds) to download as
              an MP3 — no re-encode, so quality is identical to the source.
            </p>

            <div className="grid grid-cols-2 gap-4">
              <label className="block">
                <span className="block text-[11px] uppercase tracking-wider font-semibold text-ink/50 mb-1">
                  Start
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => adjustStart(-5)}
                    data-testid="share-clip-start-down"
                    aria-label="Move start back 5 seconds"
                    className="w-7 h-7 rounded-full border border-ink/15 text-ink/60 hover:bg-ink/4"
                  >
                    −
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    data-testid="share-clip-start-input"
                    value={formatTime(startSec)}
                    onChange={(e) => onStartInput(e.target.value)}
                    aria-label="Clip start time"
                    className="flex-1 text-center tabular-nums font-semibold text-ink rounded-full bg-canvas border border-ink/15 px-3 py-1.5 focus:outline-hidden focus:border-ink/40"
                  />
                  <button
                    type="button"
                    onClick={() => adjustStart(5)}
                    data-testid="share-clip-start-up"
                    aria-label="Move start forward 5 seconds"
                    className="w-7 h-7 rounded-full border border-ink/15 text-ink/60 hover:bg-ink/4"
                  >
                    +
                  </button>
                </div>
              </label>

              <label className="block">
                <span className="block text-[11px] uppercase tracking-wider font-semibold text-ink/50 mb-1">
                  End
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => adjustEnd(-5)}
                    data-testid="share-clip-end-down"
                    aria-label="Move end back 5 seconds"
                    className="w-7 h-7 rounded-full border border-ink/15 text-ink/60 hover:bg-ink/4"
                  >
                    −
                  </button>
                  <input
                    type="text"
                    inputMode="numeric"
                    data-testid="share-clip-end-input"
                    value={formatTime(endSec)}
                    onChange={(e) => onEndInput(e.target.value)}
                    aria-label="Clip end time"
                    className="flex-1 text-center tabular-nums font-semibold text-ink rounded-full bg-canvas border border-ink/15 px-3 py-1.5 focus:outline-hidden focus:border-ink/40"
                  />
                  <button
                    type="button"
                    onClick={() => adjustEnd(5)}
                    data-testid="share-clip-end-up"
                    aria-label="Move end forward 5 seconds"
                    className="w-7 h-7 rounded-full border border-ink/15 text-ink/60 hover:bg-ink/4"
                  >
                    +
                  </button>
                </div>
              </label>
            </div>

            <div className="space-y-2">
              <label className="block">
                <span className="sr-only">Clip start (slider)</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, safeDuration)}
                  step={0.5}
                  value={startSec}
                  data-testid="share-clip-start-range"
                  onChange={(e) => onStartRange(Number(e.target.value))}
                  className="w-full accent-magenta"
                  aria-label="Clip start"
                />
              </label>
              <label className="block">
                <span className="sr-only">Clip end (slider)</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, safeDuration)}
                  step={0.5}
                  value={endSec}
                  data-testid="share-clip-end-range"
                  onChange={(e) => onEndRange(Number(e.target.value))}
                  className="w-full accent-magenta"
                  aria-label="Clip end"
                />
              </label>
            </div>

            <p
              data-testid="share-clip-summary"
              className="text-xs text-ink/60 tabular-nums flex items-center justify-between"
            >
              <span>
                Clip length:{' '}
                <span
                  className={`font-semibold ${overCap ? 'text-red-600' : 'text-ink'}`}
                  data-testid="share-clip-length"
                >
                  {formatTime(clipDuration)}
                </span>
              </span>
              <span className="text-ink/40">Max {MAX_CLIP_DURATION_SEC}s · no re-encode</span>
            </p>
            {overCap && (
              <p
                data-testid="share-clip-error"
                role="alert"
                className="text-xs text-red-600"
              >
                Clip is over the {MAX_CLIP_DURATION_SEC} s maximum. Drag the End handle back.
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <span className="text-[11px] text-ink/40">{`${MADE_WITH} · ${DOMAIN}`}</span>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="text-sm font-medium text-ink/60 hover:text-ink"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                data-testid="share-clip-confirm"
                disabled={invalid}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink-soft ${
                  invalid ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                Download clip
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

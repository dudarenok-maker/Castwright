/* Task 10 (fs-65 Phase 3) — reusable two-pass prosody annotation thunk.

   Extracted from DetectEmotionsButton.run so both the manual trigger
   (detect-emotions-button.tsx) and the eager auto-trigger (Task 13,
   layout.tsx) share the same implementation.

   Pass 1: api.detectEmotions — per-quote emotion backfill (fill-only-empty).
   Pass 2: api.detectInstruct — natural reactions / delivery instructions.

   Progress is reported on a 0–100% scale: emotions occupies 0–50%,
   instruct occupies 50–100%.

   "Detect emotions" is TWO full passes over the SAME chapters, run as two
   independent SSE requests. Each pass's server route recomputes its own
   chapterIds/totalChapters from the book's LIVE excludedChapterIds at the
   moment that request starts — so if a chapter is excluded/included in the
   wall-clock gap between pass 1 finishing and pass 2 starting, pass 2's
   totalChapters can differ from pass 1's. To keep the displayed counter
   stable, `totalChapters` is PINNED here to the widest value seen so far
   across both passes (starting from pass 1's first report) and forwarded
   to onProgress in place of each pass's raw totalChapters — it can only
   widen (never shrink/jump), so a later event's chapterIndex is never left
   exceeding the displayed total. `chapterIndex` itself is still passed
   through per-pass unmodified.

   The ETA is reconciled here into one combined number, independently of
   the totalChapters pinning above: while pass 1 runs, the combined ETA is
   pass 1's own remaining time PLUS pass 1's own total-so-far (elapsed +
   remaining), used as a stand-in for pass 2's not-yet-measured duration.
   Once pass 1 finishes, the combined ETA becomes pass 2's own remaining
   time — and until pass 2 produces its own first estimate, the last
   pass-1-derived number is held frozen rather than dropped (avoids a false
   "no estimate" blip at the pass boundary).

   Returns a summary that is NEVER thrown away on partial failures.
   `failed` is load-bearing: Task 13 only writes the prosodyAnnotated
   watermark when failed === 0. */

import { manuscriptActions } from './manuscript-slice';
import { api } from '../lib/api';
import type { AppDispatch } from './index';

/** Structured detail accompanying an onProgress tick — chapterIndex passed
    through per-pass unmodified, totalChapters pinned across both passes
    (see the module doc comment above), plus the already-reconciled combined
    ETA. */
export interface SubstageDetail {
  label?: string;
  chapterIndex?: number;
  totalChapters?: number;
  estRemainingMs?: number;
}

export interface RunProsodyPassesOpts {
  dispatch: AppDispatch;
  /** AbortSignal for cooperative cancellation (optional — Task 13 passes none). */
  signal?: AbortSignal;
  /** Called with 0–1 fraction as the two passes progress, plus the
   *  reconciled chapter/ETA detail for this tick. */
  onProgress?: (fraction: number, detail?: SubstageDetail) => void;
  /** Called with a human-readable status label from each pass's onPhase events,
   *  and with the inter-pass "Adding natural reactions…" message. Optional —
   *  Task 13 does not pass this. */
  onStatus?: (label: string) => void;
  /** Called when either pass emits an onThrottle event (rate-limit wait). Optional —
   *  Task 13 does not pass this. */
  onThrottle?: () => void;
}

export interface RunProsodyPassesResult {
  totalAnnotations: number;
  totalChapters: number;
  /** Number of chapters that failed (emitted a chapter-failed event). */
  failed: number;
}

/**
 * Run the two prosody annotation passes over the whole book.
 * Always resolves — never throws — so a partial failure is captured in
 * `failed` rather than propagating as an exception.
 */
export async function runProsodyPasses(
  bookId: string,
  { dispatch, signal, onProgress, onStatus, onThrottle }: RunProsodyPassesOpts,
): Promise<RunProsodyPassesResult> {
  let failed = 0;
  let combinedEstRemainingMs: number | undefined;
  // Pinned across both passes so the displayed chapter-of-total counter
  // never visibly jumps or shrinks if excludedChapterIds changes between
  // pass 1 and pass 2 — it can only widen (see module doc comment above).
  let pinnedTotalChapters: number | undefined;
  const pass1StartedAt = Date.now();

  // Pass 1: emotion backfill — progress 0–50%
  const emotionResult = await api.detectEmotions(bookId, {
    signal,
    onPhase: (e) => {
      if (e.estRemainingMs !== undefined) {
        const elapsedSoFarPass1 = Date.now() - pass1StartedAt;
        const pass1TotalAsPass2Proxy = elapsedSoFarPass1 + e.estRemainingMs;
        combinedEstRemainingMs = e.estRemainingMs + pass1TotalAsPass2Proxy;
      }
      pinnedTotalChapters = Math.max(
        pinnedTotalChapters ?? 0,
        e.chapterIndex ?? 0,
        e.totalChapters ?? 0,
      );
      onProgress?.(e.progress * 0.5, {
        label: e.label,
        chapterIndex: e.chapterIndex,
        totalChapters: pinnedTotalChapters,
        estRemainingMs: combinedEstRemainingMs,
      });
      if (e.label) onStatus?.(e.label);
    },
    onThrottle: () => onThrottle?.(),
    onAnnotation: (e) => dispatch(manuscriptActions.applyDetectedEmotions(e)),
    onChapterFailed: () => {
      failed++;
    },
  });

  // Inter-pass status label — mirrors the old button behaviour.
  onStatus?.('Adding natural reactions…');

  // Pass 2: instruct/vocalization — progress 50–100%
  const instructResult = await api.detectInstruct(bookId, {
    signal,
    onPhase: (e) => {
      if (e.estRemainingMs !== undefined) {
        combinedEstRemainingMs = e.estRemainingMs;
      }
      pinnedTotalChapters = Math.max(
        pinnedTotalChapters ?? 0,
        e.chapterIndex ?? 0,
        e.totalChapters ?? 0,
      );
      onProgress?.(0.5 + e.progress * 0.5, {
        label: e.label,
        chapterIndex: e.chapterIndex,
        totalChapters: pinnedTotalChapters,
        estRemainingMs: combinedEstRemainingMs,
      });
      if (e.label) onStatus?.(e.label);
    },
    onThrottle: () => onThrottle?.(),
    onAnnotation: (e) => dispatch(manuscriptActions.applyDetectedInstruct(e)),
    onChapterFailed: () => {
      failed++;
    },
  });

  const totalAnnotations = emotionResult.totalAnnotations + instructResult.totalAnnotations;
  const totalChapters = Math.max(
    emotionResult.annotatedChapters,
    instructResult.annotatedChapters,
  );

  return { totalAnnotations, totalChapters, failed };
}

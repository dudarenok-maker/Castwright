/* Task 10 (fs-65 Phase 3) — reusable two-pass prosody annotation thunk.

   Extracted from DetectEmotionsButton.run so both the manual trigger
   (detect-emotions-button.tsx) and the eager auto-trigger (Task 13,
   layout.tsx) share the same implementation.

   Pass 1: api.detectEmotions — per-quote emotion backfill (fill-only-empty).
   Pass 2: api.detectInstruct — natural reactions / delivery instructions.

   Progress is reported on a 0–100% scale: emotions occupies 0–50%,
   instruct occupies 50–100%.

   Returns a summary that is NEVER thrown away on partial failures.
   `failed` is load-bearing: Task 13 only writes the prosodyAnnotated
   watermark when failed === 0. */

import { manuscriptActions } from './manuscript-slice';
import { api } from '../lib/api';
import type { AppDispatch } from './index';

export interface RunProsodyPassesOpts {
  dispatch: AppDispatch;
  /** AbortSignal for cooperative cancellation (optional — Task 13 passes none). */
  signal?: AbortSignal;
  /** Called with 0–1 fraction as the two passes progress. */
  onProgress?: (fraction: number) => void;
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

  // Pass 1: emotion backfill — progress 0–50%
  const emotionResult = await api.detectEmotions(bookId, {
    signal,
    onPhase: (e) => {
      onProgress?.(e.progress * 0.5);
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
      onProgress?.(0.5 + e.progress * 0.5);
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

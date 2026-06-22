/** Single source of truth for render-integrity constants shared across tasks. */

export const EMBEDDINGS_VERSION = 'spk-ecapa-v1';

/** Minimum chapter-segment duration (seconds) below which embeddings are
 *  considered unreliable — shared by the embed pass (Task 6) and scoring
 *  (Task 8). */
export const MIN_DURATION_SEC = 3.0;

/* Which Qwen base tiers a generation RUN needs (#1393, plan 293 §2.2).

   A run's keep set is the OR of `chapterQwenTierNeeds` over P, where
   P = this POST's target chapters ∪ the chapters of THIS book that still hold a
   pending queue entry (queued | in_progress | paused | awaiting_confirm).
   A target chapter is evaluated at the REQUEST's Qwen key (the POST's own queue
   entry is never consulted for it); a pending non-target chapter is evaluated
   at its entry's stamped `modelKey`, or at the request's key when unstamped
   (§2.6, D8). `done` / `failed` entries, other books' entries and chapters that
   are neither a target nor pending contribute nothing; a pending chapter with
   no cached sentences contributes nothing.

   PURE: the caller reads the queue file and the analysis cache. Reused by the
   same-book job union (#4557) and the post-score path (#4560). */

import type { SentenceOutput } from '../handoff/schemas.js';
import type { CastIdHistory } from '../store/cast-id-history.js';
import type { QueueEntry, QueueStatus } from '../workspace/queue-io.js';
import type { TtsEngine } from './index.js';
import { canonicalModelKeyForEngine, type TtsModelKey } from './model-keys.js';
import { chapterQwenTierNeeds } from './qwen-tier-needs.js';
import type { CastCharacter } from './synthesise-chapter.js';

const PENDING_STATUSES: ReadonlySet<QueueStatus> = new Set<QueueStatus>([
  'queued',
  'in_progress',
  'paused',
  'awaiting_confirm',
]);

export interface RunQwenNeedsInput {
  bookId: string;
  /** This POST's target chapter ids. */
  targetChapterIds: readonly number[];
  /** Entries of the (already-read) queue file; any book, any status. */
  queueEntries: readonly QueueEntry[];
  /** `analysis.chapters`: sentences by chapter id. */
  analysisChapters: Record<string, SentenceOutput[] | undefined> | Record<number, SentenceOutput[] | undefined>;
  /** Hydrated cast, after the non-English engine forcing. */
  cast: CastCharacter[];
  castIdHistory?: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'>;
  defaultEngine: TtsEngine;
  /** The request's Qwen key (`resolveForEngine('qwen').modelKey`). */
  requestQwenModelKey: TtsModelKey;
  qwenUnavailable: boolean;
}

/** Chapter ids of `bookId` with a pending entry, mapped to the Qwen key they
    will render at (the entry's stamp, else the request's key). */
export function pendingChapterQwenKeys(
  entries: readonly QueueEntry[],
  bookId: string,
  requestQwenModelKey: TtsModelKey,
): Map<number, TtsModelKey> {
  const out = new Map<number, TtsModelKey>();
  for (const e of entries) {
    if (e.bookId !== bookId || !PENDING_STATUSES.has(e.status)) continue;
    const key = canonicalModelKeyForEngine('qwen', e.modelKey ?? requestQwenModelKey);
    /* Several pending entries for one chapter: the higher tier wins (keep both
       would over-keep; 1.7B outranks 0.6B). */
    const prev = out.get(e.chapterId);
    if (prev === undefined || (key === 'qwen3-tts-1.7b' && prev !== key)) out.set(e.chapterId, key);
  }
  return out;
}

export function computeRunQwenNeeds(input: RunQwenNeedsInput): { keep06: boolean; keep17: boolean } {
  const sentencesOf = (id: number): SentenceOutput[] =>
    (input.analysisChapters as Record<number, SentenceOutput[] | undefined>)[id] ?? [];
  const targets = new Set(input.targetChapterIds);
  const chapters = new Map<number, TtsModelKey>();
  for (const id of targets) chapters.set(id, input.requestQwenModelKey);
  for (const [id, key] of pendingChapterQwenKeys(
    input.queueEntries,
    input.bookId,
    input.requestQwenModelKey,
  )) {
    if (!targets.has(id)) chapters.set(id, key);
  }

  let keep06 = false;
  let keep17 = false;
  for (const [id, key] of chapters) {
    const sentences = sentencesOf(id);
    if (sentences.length === 0 && !targets.has(id)) continue;
    const need = chapterQwenTierNeeds({
      sentences,
      cast: input.cast,
      castIdHistory: input.castIdHistory,
      defaultEngine: input.defaultEngine,
      runQwenModelKey: key,
      qwenUnavailable: input.qwenUnavailable,
      includesTitleBeat: true,
    });
    keep06 ||= need.keep06;
    keep17 ||= need.keep17;
  }
  return { keep06, keep17 };
}

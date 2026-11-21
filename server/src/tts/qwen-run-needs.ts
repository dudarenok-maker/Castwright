/* Which Qwen base tiers a generation RUN needs (#1393, plan 293 §2.2).

   A run's keep set is the OR of `chapterQwenTierNeeds` over P, where
   P = this POST's target chapters ∪ the chapters of THIS book that still hold a
   pending queue entry (queued | in_progress | paused | awaiting_confirm).
   A target chapter is evaluated at the REQUEST's Qwen key (the POST's own `in_progress`
   queue entry is never consulted for it; its other pending entries are); a pending non-target chapter is evaluated
   at its entry's stamped `modelKey` (engine and Qwen tier), or at the request's
   engine and key when unstamped (§2.6, D8); several pending entries of one chapter
   each count. `done` / `failed` entries, other books' entries and chapters that
   are neither a target nor pending contribute nothing; a pending chapter with
   no cached sentences contributes nothing.

   PURE: the caller reads the queue file and the analysis cache. Reused by the
   same-book job union (#4557) and the post-score path (#4560). */

import type { SentenceOutput } from '../handoff/schemas.js';
import type { CastIdHistory } from '../store/cast-id-history.js';
import type { QueueEntry, QueueStatus } from '../workspace/queue-io.js';
import type { TtsEngine } from './index.js';
import { canonicalModelKeyForEngine, engineForModelKey, type TtsModelKey } from './model-keys.js';
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

/** One render of a chapter: the engine its POST defaults to and the Qwen key it runs at. */
interface ChapterRun {
  chapterId: number;
  defaultEngine: TtsEngine;
  qwenModelKey: TtsModelKey;
}

export function computeRunQwenNeeds(input: RunQwenNeedsInput): { keep06: boolean; keep17: boolean } {
  const sentencesOf = (id: number): SentenceOutput[] =>
    (input.analysisChapters as Record<number, SentenceOutput[] | undefined>)[id] ?? [];
  const targets = new Set(input.targetChapterIds);
  const runs = new Map<string, ChapterRun>();
  const add = (r: ChapterRun) => runs.set(`${r.chapterId}|${r.defaultEngine}|${r.qwenModelKey}`, r);
  for (const chapterId of targets) {
    add({ chapterId, defaultEngine: input.defaultEngine, qwenModelKey: input.requestQwenModelKey });
  }
  /* Every pending entry renders on its own POST, so a chapter with several counts once per entry
     (a re-queue at another tier needs both). A stamped entry runs at its stamp's ENGINE as well as
     its Qwen tier; an unstamped one follows the request. */
  for (const e of input.queueEntries) {
    if (e.bookId !== input.bookId || !PENDING_STATUSES.has(e.status)) continue;
    /* Only a target chapter's own `in_progress` entry (the one this POST runs) is skipped: the
       dispatcher flips an entry to `in_progress` at claim, before its POST, and the target is already
       evaluated at the request's key. Its queued / paused / awaiting_confirm entries (a re-queue at
       another tier) still render on their own POST and count at their stamps. */
    if (targets.has(e.chapterId) && e.status === 'in_progress') continue;
    add({
      chapterId: e.chapterId,
      defaultEngine: e.modelKey ? engineForModelKey(e.modelKey) : input.defaultEngine,
      qwenModelKey: canonicalModelKeyForEngine('qwen', e.modelKey ?? input.requestQwenModelKey),
    });
  }

  let keep06 = false;
  let keep17 = false;
  for (const r of runs.values()) {
    const sentences = sentencesOf(r.chapterId);
    if (sentences.length === 0 && !targets.has(r.chapterId)) continue;
    const need = chapterQwenTierNeeds({
      sentences,
      cast: input.cast,
      castIdHistory: input.castIdHistory,
      defaultEngine: r.defaultEngine,
      runQwenModelKey: r.qwenModelKey,
      qwenUnavailable: input.qwenUnavailable,
      includesTitleBeat: true,
    });
    keep06 ||= need.keep06;
    keep17 ||= need.keep17;
  }
  return { keep06, keep17 };
}

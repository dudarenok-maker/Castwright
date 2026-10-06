/* Resumable analysis cache. Each successful stage / chapter is written to
   server/handoff/cache/{manuscriptId}.json so a mid-analysis failure (rate
   limit, network blip, the user picking a different model and hitting retry)
   doesn't lose work. The route loads the cache on entry and short-circuits
   anything already complete. Cache is keyed by manuscriptId only — switching
   models on retry is intentional, the design lets the user keep partial
   progress from model A and finish on model B. */

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharacterOutput, SentenceOutput, Stage1Output } from '../handoff/schemas.js';
import { extractInlineEmotion } from '../handoff/emotion-from-tags.js';
import { readJson, enqueuePathOp } from '../workspace/state-io.js';
import { writeJsonAtomicOrdered } from '../workspace/ordered-write.js';
import { safeSegment, assertContained, sanitizeIdSegment } from '../util/safe-path.js';

/* fs-25 — absorb any legacy inline audio-tag in a freshly-analysed sentence
   into the structured `emotion` field and strip the bracket from the stored
   text, so the retired tag system leaves no residue in new caches. Idempotent:
   already-clean sentences pass through unchanged, and an existing `emotion`
   (manual or analyzer-set) is never overridden. */
/* Validate the on-disk cache shape before anything iterates it. Each chapter
   entry must be an array of sentences (`Record<number, SentenceOutput[]>`).
   A malformed entry — e.g. an index-keyed object `{ "0": {...} }` written by a
   buggy external repair — otherwise throws a context-free
   "sentences.map is not a function" deep in seedEmotionsFromTags, which the UI
   surfaces as an inscrutable "Re-analysis failed". Failing here names the
   manuscript + chapter so the corruption is actionable (re-run that chapter or
   restore the cache). Asserts the type so callers narrow to the array shape. */
export function assertCacheChaptersShape(
  chapters: Record<number, unknown>,
  manuscriptId?: string,
): asserts chapters is Record<number, SentenceOutput[]> {
  for (const [chapterId, sentences] of Object.entries(chapters)) {
    if (!Array.isArray(sentences)) {
      const got = sentences === null ? 'null' : typeof sentences;
      throw new Error(
        `Analysis cache${manuscriptId ? ` for ${manuscriptId}` : ''} chapter ${chapterId} is ` +
          `malformed: expected an array of sentences, got ${got}. The cache file is corrupt — ` +
          `re-run analysis for this chapter or restore the cache from a backup.`,
      );
    }
  }
}

function seedEmotionsFromTags(chapters: Record<number, SentenceOutput[]>): Record<number, SentenceOutput[]> {
  assertCacheChaptersShape(chapters);
  const out: Record<number, SentenceOutput[]> = {};
  for (const [chapterId, sentences] of Object.entries(chapters)) {
    out[Number(chapterId)] = sentences.map((s) => {
      const { text, emotion } = extractInlineEmotion(s.text, s.emotion);
      return text === s.text && emotion === s.emotion ? s : { ...s, text, emotion };
    });
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, '..', '..', 'handoff', 'cache');

/** fs-19 — one classified per-chapter analysis failure (message = the
    jargon-free userMessage at classification time). */
export interface ChapterErrorRecord {
  code: string;
  message: string;
  remediation: string;
  /** Which phase failed: Phase 0a cast detection or Phase 1 attribution.
      Optional on disk only for records written before plan 286;
      `normaliseFailureRecords` tags those on load. */
  phase?: 'cast' | 'attribution';
}

const MISSING_RECORD_MESSAGE = 'Analysis failed on a previous attempt. Retry to try again.';

/* Plan 286 spec 2.1 — tag the untagged legacy failure records of a freshly
   loaded cache, mutating it in place. Rules, first match wins:
   1. already tagged: keep;
   2. no stage1 and the cast is missing or `[]`: 'cast' (origin/main writes
      coverage flags over any record, and pipelined Phase 1 can attribute a
      chapter whose cast failed, so `{attribution-*, [], take, no stage1}`
      exists on disk);
   3. attribution-collapse / attribution-incomplete: 'attribution';
   4. a non-empty cast: 'attribution' (cast failures write `[]`; covers the
      2026-06-05..06-12 records that have no record object);
   5. otherwise 'cast'.
   An id with no record gets a synthesised 'unknown' one. */
export function normaliseFailureRecords(cache: AnalysisCache): void {
  const ids = cache.failedChapterIds;
  if (!ids || ids.length === 0) return;
  const records = (cache.failedChapterErrors ??= {});
  for (const id of ids) {
    const existing = records[String(id)];
    if (existing?.phase) continue;
    const castRows = cache.chapterCast?.[id];
    const castEmpty = !castRows || castRows.length === 0;
    let phase: 'cast' | 'attribution';
    if (!cache.stage1 && castEmpty) phase = 'cast';
    else if (existing?.code === 'attribution-collapse' || existing?.code === 'attribution-incomplete')
      phase = 'attribution';
    else if (!castEmpty) phase = 'attribution';
    else phase = 'cast';
    records[String(id)] = existing
      ? { ...existing, phase }
      : { code: 'unknown', message: MISSING_RECORD_MESSAGE, remediation: '', phase };
  }
}

export interface AnalysisCache {
  /** Phase 0a — raw per-chapter character output keyed by chapterId. The
      route replays these in chapter-id order through the merge to rebuild
      the running roster on resume when stage1 isn't yet present. */
  chapterCast?: Record<number, CharacterOutput[]>;
  /** Phase 0b output — finalised, sorted, palette-coloured roster. Set
      once Phase 0 completes; on resume the route skips Phase 0a entirely
      when this is present. */
  stage1?: Stage1Output;
  /** chapterId → sentences. Keyed by number-as-string per JSON convention. */
  chapters: Record<number, SentenceOutput[]>;
  /** Per-chapter Phase 0a wall-clock durations (ms) and Phase 1 durations,
      both keyed by chapterId. Persisted so that a resumed run already has
      observed-rate samples — without this, the first chapter of every
      resume falls back to the static formula, which on local Ollama
      under-estimates the budget by 3-5×. */
  castDurations?: Record<number, number>;
  stage2Durations?: Record<number, number>;
  /** Engine that produced the currently-stored durations for each phase
      ('gemini' | 'local'). The observed-rate seed is only valid when the
      resumed run uses the SAME engine — a Gemini-paced duration mis-seeds a
      Qwen run's ETA by ~10× (2026-06-14 model-switch report). On a mismatch
      the route discards that phase's stale durations and re-stamps the engine.
      Undefined on caches written before this field existed → treated as a
      mismatch (don't seed), which is the safe default. */
  castDurationsEngine?: string;
  stage2DurationsEngine?: string;
  /** Chapter ids whose Phase 0a cast detection threw after the analyzer's
      built-in retry. The matching `chapterCast[id]` entry is `[]` (the
      failure marker — see analysis.ts catch path), but storing the id list
      separately lets the UI distinguish "tried and failed" from "tried and
      genuinely had no cast" and surface a per-chapter retry affordance
      that survives reload. Subset re-runs remove the id on success. */
  failedChapterIds?: number[];
  /** fs-19 (analysis half) — per-chapter structured failure record, keyed by
      chapterId-as-string (JSON object keys). Additive sibling of
      failedChapterIds: ids stay the durable retry list; this carries the
      classified code + copy so the analysing view shows a real message +
      remediation after reload instead of the generic fallback. */
  failedChapterErrors?: Record<string, ChapterErrorRecord>;
  /** Plan 286 spec 2.2 — P: chapters whose take predates the final roster and
      is known to be bad (a failed chapter's take at a stage1-less load, or a
      take made against the rolling roster while the chapter's cast record
      stood). A pending take is kept, never deleted, until it is replaced.
      Absent means empty. */
  pendingAttributionChapterIds?: number[];
  /** Plan 286 spec 2.2 — false means a take was written after the last
      authoritative persist (state.json). Absent (legacy caches) means
      persisted. */
  takesPersisted?: boolean;
  /** Plan 286 decision F — set by the first authoritative persist and never
      cleared except with the cache: the book has reached Confirm. */
  confirmReached?: true;
  updatedAt?: string;
}

/** Plan 286 spec 2.2 — the one per-chapter "done" predicate: the chapter has a
    take (an own key, including `[]`, decision B) that is not pending. */
export function hasCurrentTake(cache: AnalysisCache, chapterId: number): boolean {
  return (
    Object.hasOwn(cache.chapters, chapterId) &&
    !(cache.pendingAttributionChapterIds ?? []).includes(chapterId)
  );
}

/** Plan 286 spec 2.2 — book-level completeness over `chapterIds` (the
    non-excluded chapters): the roster is final, every chapter has a current
    take, and no take was written after the last authoritative persist. */
export function analysisCompleteFor(cache: AnalysisCache, chapterIds: readonly number[]): boolean {
  return (
    chapterIds.length === 0 ||
    (!!cache.stage1 &&
      chapterIds.every((id) => hasCurrentTake(cache, id)) &&
      cache.takesPersisted !== false)
  );
}

/** Plan 286 §3.4 — the chapters of `chapterIds` (the non-excluded chapters)
    that have no current take. */
export function unattributedChapterIds(cache: AnalysisCache, chapterIds: readonly number[]): number[] {
  return chapterIds.filter((id) => !hasCurrentTake(cache, id));
}

/** Plan 286 decision F — the book has reached Confirm: its cast was confirmed,
    or an authoritative persist has run since the cache was last cleared. */
export function reachedConfirm(
  state: { castConfirmed?: boolean } | null | undefined,
  cache: AnalysisCache,
): boolean {
  return state?.castConfirmed === true || cache.confirmReached === true;
}

export function cachePath(manuscriptId: string): string {
  const p = join(CACHE_DIR, `${sanitizeIdSegment(safeSegment(manuscriptId))}.json`);
  assertContained(CACHE_DIR, p);
  return p;
}

export async function loadAnalysisCache(manuscriptId: string): Promise<AnalysisCache> {
  const cache = await readJson<AnalysisCache>(cachePath(manuscriptId));
  if (!cache) return { chapters: {} };
  /* Fail loud + contextful on a corrupt cache (a chapter entry that isn't an
     array) before any phase does work, instead of a context-free TypeError on
     the next save. */
  assertCacheChaptersShape(cache.chapters ?? {}, manuscriptId);
  /* JSON parse turns the chapter-id keys into strings, but the route uses
     numeric ids. Coerce shape so callers can use cache.chapters[chapterId]
     directly. */
  const loaded: AnalysisCache = {
    chapterCast: cache.chapterCast ?? undefined,
    stage1: cache.stage1,
    chapters: cache.chapters ?? {},
    castDurations: cache.castDurations ?? undefined,
    stage2Durations: cache.stage2Durations ?? undefined,
    castDurationsEngine: cache.castDurationsEngine ?? undefined,
    stage2DurationsEngine: cache.stage2DurationsEngine ?? undefined,
    failedChapterIds: cache.failedChapterIds ?? undefined,
    failedChapterErrors: cache.failedChapterErrors ?? undefined,
    pendingAttributionChapterIds: cache.pendingAttributionChapterIds ?? undefined,
    takesPersisted: cache.takesPersisted ?? undefined,
    confirmReached: cache.confirmReached ?? undefined,
    updatedAt: cache.updatedAt,
  };
  normaliseFailureRecords(loaded);
  return loaded;
}

/* #3427 — saves and clears for one manuscript run through the shared per-path
   op chain (`enqueuePathOp`, workspace/state-io.ts), so they land in call
   order. */
export async function saveAnalysisCache(manuscriptId: string, cache: AnalysisCache): Promise<void> {
  const path = cachePath(manuscriptId);
  /* Built at call time; `writeJsonAtomicOrdered` then deep-snapshots it, so the
     bytes written are fixed at call time however long the chain delays them. */
  const payload = {
    ...cache,
    chapters: seedEmotionsFromTags(cache.chapters ?? {}),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomicOrdered(path, payload);
}

/* Discard any partial progress for a manuscript so the next analysis runs
   from scratch. Idempotent — no-op if the cache file doesn't exist. */
export async function clearAnalysisCache(manuscriptId: string): Promise<void> {
  /* Joins the same per-path chain as saves (#3427): lands after every save
     called before it, and a later save lands after it. */
  const path = cachePath(manuscriptId);
  await enqueuePathOp(path, () => rm(path, { force: true }));
}

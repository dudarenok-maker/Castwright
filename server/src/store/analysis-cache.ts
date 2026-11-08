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
import type { LedgerEntry, MatchDecision, MatchPlan, RunAddedLedger } from './reanalysis-types.js';
import { readJson, enqueuePathOp, writeJsonAtomic } from '../workspace/state-io.js';
import { writeJsonAtomicOrdered } from '../workspace/ordered-write.js';
import { jitteredDelayMs } from '../workspace/atomic-rename.js';
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
      Optional on disk only for records written before plan 287;
      `normaliseFailureRecords` tags those on load. */
  phase?: 'cast' | 'attribution';
}

const MISSING_RECORD_MESSAGE = 'Analysis failed on a previous attempt. Retry to try again.';

/* plan 287 spec 2.1 — tag the untagged legacy failure records of a freshly
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

/** Written by every cache the current code creates; anything else classifies `legacy`. */
export const ANALYSIS_CACHE_VERSION = 2;

export type AnalysisCacheClass =
  'empty' | 'legacy' | 'current-pre0b' | 'current-unplanned' | 'current-planned';

export interface AnalysisCache {
  /** #4031 — absent on a cache written before the match plan existed. */
  version?: number;
  /** #4031 — the frozen fresh→prior decisions of the run in flight. */
  matchPlan?: MatchPlan;
  /** #4031 rule 11 — rows the run added to cast.json, with their last-write fingerprint. */
  addedRows?: RunAddedLedger;
  /** #4031 — suggestion pairs the run added, saved with each snapshot. */
  runAddedPairs?: Array<[string, string]>;
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
  /** plan 287 spec 2.2 — P: chapters whose take predates the final roster and
      is known to be bad (a failed chapter's take at a stage1-less load, or a
      take made against the rolling roster while the chapter's cast record
      stood). A pending take is kept, never deleted, until it is replaced.
      Absent means empty. */
  pendingAttributionChapterIds?: number[];
  /** plan 287 spec 2.2 — false means a take was written after the last
      authoritative persist (state.json). Absent (legacy caches) means
      persisted. */
  takesPersisted?: boolean;
  /** plan 287 decision F — set by the first authoritative persist and never
      cleared except with the cache: the book has reached Confirm. */
  confirmReached?: true;
  updatedAt?: string;
}

/** #4031 cache lifecycle. `legacy` is any non-empty cache whose version is not the current one. */
export function classifyAnalysisCache(cache: AnalysisCache): AnalysisCacheClass {
  const hasChapters = Object.keys(cache.chapters ?? {}).length > 0;
  const hasCast = Object.keys(cache.chapterCast ?? {}).length > 0;
  if (!cache.stage1 && !hasCast && !hasChapters && (cache.failedChapterIds ?? []).length === 0)
    return 'empty';
  if (cache.version !== ANALYSIS_CACHE_VERSION) return 'legacy';
  if (!cache.stage1) return 'current-pre0b';
  return cache.matchPlan ? 'current-planned' : 'current-unplanned';
}

/** plan 287 spec 2.2 — the one per-chapter "done" predicate: the chapter has a
    take (an own key, including `[]`, decision B) that is not pending. */
export function hasCurrentTake(cache: AnalysisCache, chapterId: number): boolean {
  return (
    Object.hasOwn(cache.chapters, chapterId) &&
    !(cache.pendingAttributionChapterIds ?? []).includes(chapterId)
  );
}

/** plan 287 spec 2.2 — book-level completeness over `chapterIds` (the
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

/** plan 287 §3.4 — the chapters of `chapterIds` (the non-excluded chapters)
    that have no current take. */
export function unattributedChapterIds(cache: AnalysisCache, chapterIds: readonly number[]): number[] {
  return chapterIds.filter((id) => !hasCurrentTake(cache, id));
}

/** plan 287 decision F — the book has reached Confirm: its cast was confirmed,
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
  return coerceLoadedCache(await readJson<AnalysisCache>(cachePath(manuscriptId)), manuscriptId);
}

function coerceLoadedCache(cache: AnalysisCache | null, manuscriptId: string): AnalysisCache {
  if (!cache) return { chapters: {} };
  /* Fail loud + contextful on a corrupt cache (a chapter entry that isn't an
     array) before any phase does work, instead of a context-free TypeError on
     the next save. */
  assertCacheChaptersShape(cache.chapters ?? {}, manuscriptId);
  /* JSON parse turns the chapter-id keys into strings, but the route uses
     numeric ids. Coerce shape so callers can use cache.chapters[chapterId]
     directly. */
  const loaded: AnalysisCache = {
    version: cache.version ?? undefined,
    matchPlan: cache.matchPlan ?? undefined,
    addedRows: cache.addedRows ?? undefined,
    runAddedPairs: cache.runAddedPairs ?? undefined,
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
function buildCachePayload(cache: AnalysisCache): AnalysisCache {
  return {
    ...cache,
    chapters: seedEmotionsFromTags(cache.chapters ?? {}),
    updatedAt: new Date().toISOString(),
  };
}

/* `version` is written exactly as given: a save never stamps it, so a loaded
   legacy cache stays legacy (plan 291 Review Focus 1). */
export async function saveAnalysisCache(manuscriptId: string, cache: AnalysisCache): Promise<void> {
  const path = cachePath(manuscriptId);
  /* Built at call time; `writeJsonAtomicOrdered` then deep-snapshots it, so the
     bytes written are fixed at call time however long the chain delays them. */
  await writeJsonAtomicOrdered(path, buildCachePayload(cache));
}

/** A patch applied atomically by `mutateAnalysisCache`. */
export interface CachePatch {
  chapters?: Record<number, SentenceOutput[]>;
  /** Default `'merge'` (per chapter key); `'replace'` swaps the whole map. */
  chaptersMode?: 'merge' | 'replace';
  castDurations?: Record<number, number>;
  stage2Durations?: Record<number, number>;
  /** Merged per key into `matchPlan.decisions`. Needs a plan on disk or `matchPlan` in this patch. */
  decisions?: Record<string, MatchDecision>;
  /** Sets the plan header. A different `runToken` than the stored one starts the decisions over. */
  matchPlan?: Omit<MatchPlan, 'decisions'>;
  /** Merged per key into `addedRows`; `null` deletes the key. */
  ledger?: Record<string, LedgerEntry | null>;
  /** Unioned into `runAddedPairs`. */
  runAddedPairs?: Array<[string, string]>;
  /** Deletes `runAddedPairs` and every `run-owned` ledger entry; `added-once` entries stay (sticky user delete). */
  clearLedger?: true;
  stage1?: Stage1Output;
  /** Written exactly as given. */
  version?: number;
  /** Without it an absent file is left absent and the op returns `null`. */
  createIfAbsent?: true;
  /** The version of a file this op creates (default `ANALYSIS_CACHE_VERSION`); ignored when the file exists. */
  versionIfCreated?: number;
  fields?: Partial<
    Pick<
      AnalysisCache,
      | 'chapterCast'
      | 'failedChapterIds'
      | 'failedChapterErrors'
      | 'pendingAttributionChapterIds'
      | 'takesPersisted'
      | 'confirmReached'
      | 'castDurationsEngine'
      | 'stage2DurationsEngine'
    >
  >;
  /** Rewrites `characterId` in the chapter takes and the id in `chapterCast`. */
  remapCharacterIds?: Record<string, string>;
  /** Runs last, on the patched cache, inside the same op. */
  transform?: (cache: AnalysisCache) => AnalysisCache;
}

/* Read-modify-write as ONE `enqueuePathOp` op. The queue is not re-entrant, so
   the body must never call `saveAnalysisCache` / `writeJsonAtomicOrdered`
   (both enqueue on this same path and would wait on themselves). */
export async function mutateAnalysisCache(
  manuscriptId: string,
  patch: CachePatch,
): Promise<AnalysisCache | null> {
  const path = cachePath(manuscriptId);
  let result: AnalysisCache | null = null;
  await enqueuePathOp(path, async () => {
    const existing = await readJson<AnalysisCache>(path);
    if (!existing && !patch.createIfAbsent) return;
    let cache = coerceLoadedCache(existing, manuscriptId);
    if (!existing) cache.version = patch.versionIfCreated ?? ANALYSIS_CACHE_VERSION;
    if (patch.version !== undefined) cache.version = patch.version;
    if (patch.stage1) cache.stage1 = patch.stage1;
    if (patch.chapters) {
      cache.chapters =
        patch.chaptersMode === 'replace'
          ? { ...patch.chapters }
          : { ...cache.chapters, ...patch.chapters };
    }
    if (patch.castDurations)
      cache.castDurations = { ...cache.castDurations, ...patch.castDurations };
    if (patch.stage2Durations)
      cache.stage2Durations = { ...cache.stage2Durations, ...patch.stage2Durations };
    if (patch.fields) Object.assign(cache, patch.fields);
    if (patch.matchPlan) {
      const keep =
        cache.matchPlan?.runToken === patch.matchPlan.runToken ? cache.matchPlan.decisions : {};
      cache.matchPlan = { ...patch.matchPlan, decisions: keep };
    }
    if (patch.decisions) {
      if (!cache.matchPlan)
        throw new Error('mutateAnalysisCache: decisions patched with no matchPlan');
      cache.matchPlan = {
        ...cache.matchPlan,
        decisions: { ...cache.matchPlan.decisions, ...patch.decisions },
      };
    }
    if (patch.clearLedger) {
      delete cache.runAddedPairs;
      cache.addedRows = Object.fromEntries(
        Object.entries(cache.addedRows ?? {}).filter(([, e]) => e.state !== 'run-owned'),
      );
    }
    if (patch.ledger) {
      const rows = { ...cache.addedRows };
      for (const [k, entry] of Object.entries(patch.ledger)) {
        if (entry === null) delete rows[k];
        else rows[k] = entry;
      }
      cache.addedRows = rows;
    }
    if (patch.runAddedPairs) {
      const seen = new Set((cache.runAddedPairs ?? []).map(([a, b]) => `${a}\u0000${b}`));
      const merged = [...(cache.runAddedPairs ?? [])];
      for (const [a, b] of patch.runAddedPairs) {
        if (!seen.has(`${a}\u0000${b}`)) {
          seen.add(`${a}\u0000${b}`);
          merged.push([a, b]);
        }
      }
      cache.runAddedPairs = merged;
    }
    if (patch.remapCharacterIds) {
      const map = patch.remapCharacterIds;
      const to = (id: string) => map[id] ?? id;
      cache.chapters = Object.fromEntries(
        Object.entries(cache.chapters).map(([k, ss]) => [
          k,
          ss.map((s) => ({ ...s, characterId: to(s.characterId) })),
        ]),
      );
      if (cache.chapterCast) {
        cache.chapterCast = Object.fromEntries(
          Object.entries(cache.chapterCast).map(([k, rows]) => [
            k,
            rows.map((r) => ({ ...r, id: to(r.id) })),
          ]),
        );
      }
    }
    if (patch.transform) cache = patch.transform(cache);
    const payload = buildCachePayload(cache);
    await writeJsonAtomic(path, payload);
    result = payload;
  });
  return result as AnalysisCache | null;
}

/* Discard any partial progress for a manuscript so the next analysis runs
   from scratch. Idempotent — no-op if the cache file doesn't exist. */
export async function clearAnalysisCache(manuscriptId: string): Promise<void> {
  /* Joins the same per-path chain as saves (#3427): lands after every save
     called before it, and a later save lands after it. */
  const path = cachePath(manuscriptId);
  await enqueuePathOp(path, () => rm(path, { force: true }));
}

/* PR #3966 pass 3 -- clearAnalysisCache for the two callers that clear AFTER a
   state.json swap already landed (backup restore, bundle overwrite): a transient
   fs fault (AV / sync-client lock) there would answer 500 with the stale cache
   kept for a later non-fresh analysis to replay. Up to 3 attempts with a short
   jittered backoff on lock-class codes only; the last error is rethrown so the
   request still fails loud. */
const CLEAR_RETRY_DELAYS_MS = [25, 75];
const CLEAR_RETRYABLE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE']);

export async function clearAnalysisCacheWithRetry(manuscriptId: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await clearAnalysisCache(manuscriptId);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (attempt >= CLEAR_RETRY_DELAYS_MS.length || !code || !CLEAR_RETRYABLE_CODES.has(code)) throw e;
      await new Promise((r) => setTimeout(r, jitteredDelayMs(CLEAR_RETRY_DELAYS_MS[attempt])));
    }
  }
}

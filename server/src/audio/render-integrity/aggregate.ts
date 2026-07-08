/**
 * srv-36 Aggregate orchestrator — builds per-character centroids and scores
 * every chapter's embeddings against them.
 *
 * Algorithm:
 *   1. For each chapter: read its embeddings sibling (skip if null) + segments file.
 *   2. Across all chapters, gather per-character anchor-eligible vectors
 *      (gate-passing AND per-segment renderedFallbackEngine unset AND
 *       stochastic-configured — qwen or coqui).
 *   3. buildCentroid per character; compute clean cosine spread; persist via writeCentroids.
 *   4. Score every embedding row for every chapter; write one
 *      `<slug>.render-integrity.json` per chapter.
 *
 * Idempotent: safe to re-run; verdict + centroid files are overwritten each call.
 * Skips Kokoro-configured characters entirely (deterministic engine, no drift risk).
 *
 * Task 10 seam: the `resolveCharacterReference` function's too-thin/bimodal branch
 * currently returns `referenceKind: 'too-short'` (placeholder). Task 10 replaces
 * this branch with the audition-centroid Option-B path. The function signature and
 * return type are stable; Task 10 only changes the branch body.
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { audioDir, castJsonPath } from '../../workspace/paths.js';
import { readJson } from '../../workspace/state-io.js';
import { loadSegmentsFiles } from '../segments-io.js';
import { readEmbeddings, type EmbeddingRow } from './embeddings-io.js';
import { writeAttempted, attemptedPath, mergeVerdictRows, type VerdictRow } from './verdicts-io.js';
import {
  readCentroids,
  writeCentroids,
  type CharacterCentroid,
} from './centroids-io.js';
import { CENTROID_MIN_N, buildCentroid } from './centroid.js';
import {
  cosineToCentroid,
  percentile,
  scoreSegment,
  CUTOFFS,
} from './score.js';
import { auditionCentroid, type AuditionCharacter, type AuditionCentroidOpts } from './audition-centroid.js';
import { readPendingAttempts, writePendingAttempts } from './pending-attempts-io.js';
import { canonicalModelKeyForEngine, type TtsModelKey } from '../../tts/model-keys.js';
import { buildHintFromCast, type CastCharacter } from '../../tts/synthesise-chapter.js';

// Duration proxy for embedding rows: every row passed Task 6's MIN_DURATION_SEC
// gate at embed time, so the duration guard inside scoreSegment never fires here.
// 10.0 s is a safe ≥-floor proxy; embedding rows don't carry duration.
const ASSUMED_DURATION_SEC = 10.0;

// ── Type for the segments file read-view (local, minimal) ─────────────────

/** Minimal segments-file read view for the aggregate. Only fields we need. */
interface SegmentsEntry {
  characterId?: string;
  sentenceIds?: number[];
  /** Per-SEGMENT fallback engine — the field we extend in segments-io.ts.
   *  Null / absent = rendered in the configured engine (anchor-eligible). */
  renderedFallbackEngine?: string | null;
}

interface SegmentsFileView {
  chapterId?: number;
  /** Render tier stamped by finalize-chapter-write (ChapterSegmentsFile.modelKey)
   *  — the model this chapter's audio was ACTUALLY rendered under. The Option-B
   *  audition centroid renders under this SAME tier (see Phase 2 below) so its
   *  embeddings are comparable to the in-book anchors AND it never pulls a 0.6B
   *  base in co-resident with a 1.7B render. Absent on legacy pre-stamp files. */
  modelKey?: TtsModelKey;
  segments?: SegmentsEntry[];
  characterSnapshots?: Record<string, {
    voiceEngine?: string;
    renderedFallbackEngine?: string;
    /** Per-character render tier (see CharacterSnapshot.modelKey). The audition
     *  renders under THIS (falls back to the chapter-level modelKey, then 0.6B). */
    modelKey?: TtsModelKey;
    /** Resolved voice name at render time (e.g. `qwen-<uuid>` or `af_sarah`). */
    resolvedVoiceName?: string;
    voiceId?: string;
    attributes?: string[];
  }>;
}

/** Stochastic engines (Kokoro-configured characters are skipped). */
export const STOCHASTIC_ENGINES = new Set(['qwen', 'coqui']);

/** Minimal per-chapter view needed to classify each character's book-wide
 *  configured engine — just enough structural shape for `characterSnapshots`
 *  readers across the codebase (both `scoreBook`'s internal `ChapterData`
 *  and `qa-report.ts`'s `SegmentsFile`) to satisfy it without adapting. */
export interface EngineClassificationSource {
  characterSnapshots?: Record<string, { voiceEngine?: string }>;
}

/**
 * Resolve each character's book-wide configured TTS engine from an ORDERED
 * list of per-chapter segments-file views — first chapter's snapshot wins.
 *
 * A mid-book engine re-cast (character starts on Kokoro, switches to Qwen
 * partway through) is classified by its FIRST rendered chapter's snapshot;
 * later chapters' snapshots for that character are ignored for this
 * book-wide classification. This is a deliberate simplification (a re-cast
 * forces new embeddings on re-render anyway), but it MUST be applied
 * identically everywhere a caller needs to know "is this character
 * stochastic, book-wide" — `scoreBook`'s Phase 2 anchor/scoring population
 * AND `qa-report.ts`'s eligibility computation both call this single
 * implementation so they can never disagree on which characters/chapters
 * are in scope (see the fs-51 PR #1433 review finding: a per-chapter
 * re-derivation in qa-report.ts could disagree with scoreBook's book-wide
 * verdict, producing a false "embed failed" count).
 *
 * Round-2 correctness note: sharing the FUNCTION isn't sufficient — both
 * callers must also feed it the identically-filtered chapter POPULATION, or
 * "first chapter wins" can still disagree. `qa-report.ts` calls this with
 * `loadSegmentsFiles`'s output: every chapter with a segments.json, full
 * stop. `scoreBook` used to call this with its own `chapterData` (chapters
 * that ALSO passed its Phase-1 embeddings-sibling check) — a character whose
 * first-ever rendered chapter is missing its embeddings sibling would then
 * be classified from a DIFFERENT "first" chapter by the two call sites. A
 * character's configured engine is a rendering-configuration fact, not an
 * embeddings-availability fact, so `scoreBook` now also calls
 * `loadSegmentsFiles` for this classification step specifically, and applies
 * its own embeddings-sibling skip separately/downstream, as a per-chapter
 * scoring-eligibility check — never conflating the two.
 *
 * @param orderedSources Segments-file-like views, in the SAME chapter order
 *   the caller wants "first" to mean.
 */
export function resolveConfiguredEngineByChar(
  orderedSources: EngineClassificationSource[],
): Map<string, string> {
  const configuredEngineByChar = new Map<string, string>();
  for (const source of orderedSources) {
    for (const [charId, snap] of Object.entries(source.characterSnapshots ?? {})) {
      if (!configuredEngineByChar.has(charId) && snap.voiceEngine) {
        configuredEngineByChar.set(charId, snap.voiceEngine);
      }
    }
  }
  return configuredEngineByChar;
}

// ── Reference resolution (Task 10 seam) ───────────────────────────────────

interface CharacterReference {
  centroid: number[];
  cleanMean: number;
  pSevere: number;
  pBand: number;
  referenceKind: 'in-book' | 'audition' | 'too-short';
}

/** Discriminates the three things that can happen when a character's
 *  in-book anchors alone aren't enough (srv-36 hardening, spec §2):
 *  - 'resolved': a usable reference — either real in-book anchors, or a
 *    successful (or reused-from-a-prior-run) audition centroid.
 *  - 'too-short': a CONCLUSIVE negative result — no voice info to attempt
 *    audition at all, or auditionCentroid completed its full render budget
 *    and the pool is still too thin/bimodal. Terminal: never retried.
 *  - 'transient-failure': auditionCentroid's synth/embed call itself threw
 *    (sidecar unreachable, timeout). NOT terminal — the caller tracks a
 *    bounded retry count (pending-attempts-io.ts) and only degrades to
 *    'too-short' after the cap is spent. Nothing is written for this
 *    outcome — the character stays genuinely unresolved this run. */
type ReferenceOutcome =
  | { status: 'resolved' | 'too-short'; ref: CharacterReference }
  | { status: 'transient-failure' };

const TOO_SHORT_REF: CharacterReference = { centroid: [], cleanMean: 0, pSevere: 0, pBand: 0, referenceKind: 'too-short' };

function persistedAsRef(row: CharacterCentroid): CharacterReference {
  return { centroid: row.centroid, cleanMean: row.cleanMean, pSevere: row.pSevere, pBand: row.pBand, referenceKind: row.referenceKind };
}

/**
 * Resolve the centroid reference for a character.
 *
 * In-book path: compute the character's centroid from anchor-eligible
 * vectors, derive the clean spread statistics. Always attempted fresh, every
 * call — cheap (pure local math, no TTS) — so a character can upgrade from
 * a prior audition/too-short result the moment enough real anchors exist
 * (srv-36 hardening, spec §2).
 *
 * Too-thin/bimodal path: if `persisted` is already a terminal `'too-short'`
 * row, that state is ABSORBING — return it verbatim, never call
 * `auditionCentroid` again. If `persisted` is a successful `'audition'` row,
 * reuse it verbatim — no new renders. Otherwise (no persisted state, or a
 * stale 'in-book' row that no longer qualifies), attempt the Option-B
 * audition centroid; its three possible outcomes map onto this function's
 * three outcomes 1:1 (see `ReferenceOutcome`'s doc comment).
 *
 * @param anchorVecs  Anchor-eligible embedding vectors collected from the book.
 * @param voiceInfo   Optional voice info for Option-B (absent when no snapshot).
 * @param persisted   This character's prior-run row from centroids.json, if any.
 * @param auditionOpts  Test-only synth/embed fn overrides, forwarded to auditionCentroid.
 */
async function resolveCharacterReference(
  anchorVecs: Float32Array[],
  voiceInfo: AuditionCharacter | undefined,
  persisted: CharacterCentroid | undefined,
  auditionOpts?: Pick<AuditionCentroidOpts, 'synthFn' | 'embedFn'>,
): Promise<ReferenceOutcome> {
  const result = buildCentroid(anchorVecs);

  if (result.kind === 'in-book' && !result.bimodal) {
    const centroidArr = Array.from(result.centroid);
    const cosines = anchorVecs
      .map((v) => cosineToCentroid(Array.from(v), centroidArr))
      .sort((a, b) => a - b);
    const cleanMean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
    const pSevere = percentile(cosines, CUTOFFS.severeEdgePctl);
    const pBand = percentile(cosines, CUTOFFS.bandUpperPctl);
    return { status: 'resolved', ref: { centroid: centroidArr, cleanMean, pSevere, pBand, referenceKind: 'in-book' } };
  }

  if (persisted?.referenceKind === 'too-short') {
    return { status: 'too-short', ref: persistedAsRef(persisted) };
  }
  if (persisted?.referenceKind === 'audition') {
    return { status: 'resolved', ref: persistedAsRef(persisted) };
  }
  if (!voiceInfo) {
    return { status: 'too-short', ref: TOO_SHORT_REF };
  }

  const audition = await auditionCentroid(voiceInfo, {
    existingAnchors: result.kind === 'too-thin' ? anchorVecs : [],
    synthFn: auditionOpts?.synthFn,
    embedFn: auditionOpts?.embedFn,
  });

  if (audition === null) return { status: 'transient-failure' };
  if (audition.kind === 'too-short') return { status: 'too-short', ref: TOO_SHORT_REF };

  const centroidArr = Array.from(audition.centroid);
  const cosines = audition.embeddings
    .map((v) => cosineToCentroid(Array.from(v), centroidArr))
    .sort((a, b) => a - b);
  const cleanMean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
  const pSevere = percentile(cosines, CUTOFFS.severeEdgePctl);
  const pBand = percentile(cosines, CUTOFFS.bandUpperPctl);
  return { status: 'resolved', ref: { centroid: centroidArr, cleanMean, pSevere, pBand, referenceKind: 'audition' } };
}

// ── Per-chapter segment lookup ─────────────────────────────────────────────

/** Read a single segments file; returns null on missing/parse error. */
async function readSegmentsFile(path: string): Promise<SegmentsFileView | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SegmentsFileView;
  } catch (e) {
    if (e && (e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

/** Read cast.json; returns null on missing/malformed (best-effort — mirrors
 *  readSegmentsFile's swallow-all contract just above). A missing or
 *  unparseable cast.json yields no hints for any character in this book —
 *  identical to this function's behavior before cast.json-sourced hints
 *  existed at all, not a new failure mode. */
async function readCastJson(bookDir: string): Promise<CastCharacter[] | null> {
  try {
    const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
    return cast?.characters ?? null;
  } catch {
    return null;
  }
}

// ── Key for joining embedding rows to segment rows ─────────────────────────

function segKey(characterId: string, sentenceIds: number[]): string {
  return `${characterId}:${sentenceIds.join(',')}`;
}

// ── scoreBook ─────────────────────────────────────────────────────────────

/**
 * Score all rendered chapters in a book for render integrity.
 *
 * For each chapter: reads `<slug>.embeddings.json` (skip if null) and
 * `<slug>.segments.json`. Builds per-character centroids across the book,
 * persists them, then scores every embedding row per chapter and writes
 * `<slug>.render-integrity.json`.
 *
 * Idempotent — safe to re-run; files are overwritten each call. Per-character
 * resolution + persistence is interleaved (srv-36 hardening): each character's
 * centroid row and verdict rows land on disk as soon as THAT character
 * resolves, cheap-first ordered, instead of batching every character to a
 * single write at the end. A character whose audition-centroid synth/embed
 * call transiently fails is retried (bounded, see pending-attempts-io.ts) on
 * a later call rather than blocking this run's other characters.
 *
 * The caller's post-audition VRAM reconcile no longer derives its keep-flags
 * from this function's return: a finalized-chapters-only view can't see an
 * in-flight sibling chapter's tier (the Finding-2 race). It reconciles
 * against the run's FULL-cast tier set instead, computed once at run start.
 *
 * @param bookDir  The book's root directory on disk.
 * @param chapters Array of `{ id, slug }` identifying the book's chapters.
 * @param justFinalizedSlugs GH #1436 fix — slugs of the chapter(s) whose OWN
 *   finalize-chapter-write just completed and triggered THIS call, as opposed
 *   to `chapters` (the full book list, read here for cross-chapter centroid
 *   purposes only). Only these chapters — plus any chapter whose embeddings
 *   sibling is independently confirmed present on disk (see the per-chapter
 *   loop below) — get the "attempted" sentinel written on this pass. Omit to
 *   treat every chapter in `chapters` as just-finalized (back-compat default
 *   for direct callers/tests that don't care about the concurrent-render race).
 * @param opts Optional progress callbacks + test-only synth/embed overrides.
 * @returns The Qwen tiers actually seen this run, and the total number of
 *   `voice-mismatch` verdict rows written.
 */
export async function scoreBook(
  bookDir: string,
  chapters: { id: number; slug: string }[],
  justFinalizedSlugs?: Iterable<string>,
  opts?: {
    /** Fires exactly once, before the per-character loop starts, with the
        final roster size — independent of whether any character actually
        resolves this run (round-2 plan-review fix: firing "started" lazily
        inside the first onCharacterScored callback meant a run where every
        character hit a transient failure — the exact "book is stuck, please
        resume" scenario this feature targets — never announced itself as
        started at all). */
    onRosterKnown?: (total: number) => void;
    onCharacterScored?: (characterId: string, index: number, total: number) => void;
    /** Test-only — forwarded to every auditionCentroid call this run. */
    __testSynthFn?: AuditionCentroidOpts['synthFn'];
    __testEmbedFn?: AuditionCentroidOpts['embedFn'];
  },
): Promise<{ usedQwenTiers: { keep06: boolean; keep17: boolean }; mismatchCount: number }> {
  const NO_TIERS = { usedQwenTiers: { keep06: false, keep17: false }, mismatchCount: 0 };
  const root = audioDir(bookDir);
  const justFinalized = new Set(justFinalizedSlugs ?? chapters.map((c) => c.slug));

  // ── Phase 1: Collect per-chapter embeddings + segments ─────────────────

  type SnapshotView = {
    voiceEngine?: string;
    resolvedVoiceName?: string;
    voiceId?: string;
    attributes?: string[];
    /** Per-character render tier — the audition renders under this. */
    modelKey?: TtsModelKey;
  };

  type ChapterData = {
    id: number;
    slug: string;
    embRows: EmbeddingRow[];
    segsByKey: Map<string, SegmentsEntry>;
    snapshots: Record<string, SnapshotView>;
    /** Render tier this chapter's audio was synthesised under (segments.json
     *  `modelKey`), used to render the Option-B audition on the SAME tier. */
    modelKey?: TtsModelKey;
  };

  const chapterData: ChapterData[] = [];

  for (const ch of chapters) {
    const embPath = join(root, `${ch.slug}.embeddings.json`);
    const segPath = join(root, `${ch.slug}.segments.json`);

    const embResult = await readEmbeddings(embPath);

    /* GH #1436 fix: the attempted sentinel is evidence that scoreBook began
       THIS CHAPTER'S OWN per-chapter processing — it must never be stamped
       for a chapter that hasn't reached that point in its own lifecycle yet.
       scoreBook re-scores the WHOLE book on every chapter-done event (so
       centroids incorporate all rendered audio), and sibling chapters of the
       same book can render concurrently — so a naive "stamp every chapter in
       `chapters`, every call" (the pre-fix behaviour) stamped chapters that
       were still mid-finalize: finalize-chapter-write.ts writes
       `<slug>.segments.json` BEFORE `<slug>.embeddings.json`, so a sibling
       chapter can look "eligible" (segments.json present, has a
       stochastic-voiced character) while its embeddings write genuinely
       hasn't landed yet — indistinguishable, at that instant, from a real
       embed failure.

       Stamp "attempted" iff EITHER:
       (a) this chapter is one of THIS call's justFinalized chapter(s) — the
           caller (generation.ts) only passes a chapter here once ITS OWN
           finalize-chapter-write has fully returned (segments AND, if
           applicable, embeddings already written or genuinely failed), so
           this is unambiguous positive evidence regardless of embed outcome;
       (b) this chapter's embeddings sibling is independently present on disk
           right now — a positive, unambiguous "this chapter's embed step
           succeeded" signal, true regardless of which chapter triggered this
           particular run. This is what lets a chapter whose OWN triggering
           call was coalesced away by a concurrently in-flight sibling run
           (see generation.ts's single-flight `scoringInFlight`) still pick
           up its attempted stamp on a LATER run, once its embeddings land.

       A chapter satisfying neither — segments.json present, embeddings.json
       absent, AND not this call's trigger — is still genuinely mid-finalize
       from this call's point of view, so it is correctly left unstamped;
       its own eventual finalize (or a later run observing its embeddings)
       will stamp it. */
    if (justFinalized.has(ch.slug) || embResult) {
      await writeAttempted(attemptedPath(root, ch.slug));
    }

    if (!embResult) continue; // no embeddings sibling → skip this chapter

    const segFile = await readSegmentsFile(segPath);
    if (!segFile) continue;

    // Build a lookup: segKey(characterId, sentenceIds) → SegmentsEntry
    const segsByKey = new Map<string, SegmentsEntry>();
    for (const seg of segFile.segments ?? []) {
      if (seg.characterId && Array.isArray(seg.sentenceIds)) {
        segsByKey.set(segKey(seg.characterId, seg.sentenceIds), seg);
      }
    }

    chapterData.push({
      id: ch.id,
      slug: ch.slug,
      embRows: embResult.rows,
      segsByKey,
      snapshots: segFile.characterSnapshots ?? {},
      modelKey: segFile.modelKey,
    });
  }

  // No chapter data → nothing to do
  if (chapterData.length === 0) return NO_TIERS;

  // ── Phase 2: Gather anchor-eligible vectors per character ───────────────

  // Collect all character IDs and their configured engines (from characterSnapshots),
  // book-wide, first-chapter-wins — via the single shared implementation also used
  // by qa-report.ts (resolveConfiguredEngineByChar). Crucially, this is fed the
  // SAME unfiltered chapter population qa-report.ts uses (every chapter with a
  // segments.json, via the shared loadSegmentsFiles, regardless of embeddings
  // availability) — NOT this function's own `chapterData` (which Phase 1 already
  // filtered down to chapters with a READABLE embeddings sibling). A character's
  // configured engine is a rendering-configuration fact (what characterSnapshots
  // says), not an embeddings-availability fact; feeding the classifier a
  // differently-filtered list than qa-report.ts's would let "first chapter wins"
  // disagree between the two call sites whenever a character's first-ever
  // rendered chapter is missing its embeddings sibling (fs-51 PR #1433 round-2
  // review finding — see resolveConfiguredEngineByChar's own doc comment).
  const classificationSources = await loadSegmentsFiles(bookDir, chapters);
  const configuredEngineByChar = resolveConfiguredEngineByChar(classificationSources);
  // srv-36 audition-centroid redesign: cast.json is the only place evidence
  // quotes live, so it's read once here (best-effort — see readCastJson) and
  // threaded onto each character's Option-B voice info as `hint`, letting
  // auditionCentroid build a per-render pool of distinct evidence quotes
  // instead of one repeated canned line.
  const castChars = await readCastJson(bookDir);
  const castById = new Map((castChars ?? []).map((c) => [c.id, c] as const));
  // Voice info for Option-B audition centroid (Task 10): voiceName + modelKey per char.
  const voiceInfoByChar = new Map<string, AuditionCharacter>();
  for (const cd of chapterData) {
    for (const [charId, snap] of Object.entries(cd.snapshots)) {
      // Collect voice info for Option-B (first chapter's snapshot wins).
      if (!voiceInfoByChar.has(charId) && snap.voiceEngine && snap.resolvedVoiceName && STOCHASTIC_ENGINES.has(snap.voiceEngine)) {
        const engine = snap.voiceEngine as import('../../tts/model-keys.js').TtsEngine;
        // Render the Option-B audition under the SAME tier this character ACTUALLY
        // rendered in — NOT a hardcoded 0.6B. canonicalModelKeyForEngine returns a
        // Qwen request key VERBATIM, so the old 'qwen3-tts-0.6b' placeholder forced
        // EVERY too-thin/bimodal Qwen character's audition (K=12 full synths) onto the
        // 0.6B base: co-resident with a 1.7B render (8GB-card OOM), and embedded under
        // a model whose speaker space isn't comparable to the 1.7B-rendered anchors (a
        // corrupt centroid). Prefer the PER-CHARACTER stamp (elevate-only tier from
        // buildCharacterSnapshots) so an elevated Qwen char in a non-Qwen-default book
        // isn't under-tiered by the chapter run-default; fall back to the chapter-level
        // modelKey, then 0.6B for legacy segments with neither stamp.
        const renderKey: TtsModelKey = snap.modelKey ?? cd.modelKey ?? 'qwen3-tts-0.6b';
        const modelKey = canonicalModelKeyForEngine(engine, renderKey);
        const castChar = castById.get(charId);
        voiceInfoByChar.set(charId, {
          voiceName: snap.resolvedVoiceName,
          modelKey,
          voice: {
            id: charId,
            // attributes may not be in the snapshot; fall back to empty
            attributes: snap.attributes,
          },
          hint: castChar ? buildHintFromCast(castChar) : undefined,
        });
      }
    }
  }

  // Filter to stochastic characters only
  const stochasticChars = new Set<string>();
  for (const [charId, engine] of configuredEngineByChar) {
    if (STOCHASTIC_ENGINES.has(engine)) stochasticChars.add(charId);
  }

  if (stochasticChars.size === 0) return NO_TIERS; // No stochastic characters → nothing to score

  // Gather anchor-eligible vectors per character:
  // eligible iff: stochastic-configured AND per-segment renderedFallbackEngine unset/null
  const anchorVecsByChar = new Map<string, Float32Array[]>();
  for (const charId of stochasticChars) anchorVecsByChar.set(charId, []);

  for (const cd of chapterData) {
    for (const row of cd.embRows) {
      if (!stochasticChars.has(row.characterId)) continue;

      const key = segKey(row.characterId, row.sentenceIds);
      const seg = cd.segsByKey.get(key);

      // Anchor-eligible: no per-segment fallback (use the per-segment field,
      // NOT characterSnapshots.renderedFallbackEngine which over-excludes)
      const hasFallback = seg?.renderedFallbackEngine != null && seg.renderedFallbackEngine !== '';
      if (!hasFallback) {
        anchorVecsByChar.get(row.characterId)!.push(row.vec);
      }
    }
  }

  // ── Phase 3+4: resolve, persist, and score each character as it resolves ──
  // srv-36 hardening: interleaved instead of two separate batch phases, so
  // a cheap character's result is visible on disk immediately instead of
  // waiting for every character (including expensive too-thin ones) to
  // finish first. Cheap-first ordered so that's ALSO true in practice, not
  // just in theory (an expensive character sorting first in the old
  // first-chapter-appearance order would otherwise still delay the first
  // write for no reason).

  const centroidsMap: Record<string, CharacterCentroid> = (await readCentroids(bookDir)) ?? {};
  const pendingMap: Record<string, number> = (await readPendingAttempts(bookDir)) ?? {};
  const MAX_PENDING_ATTEMPTS = 3;

  const orderedChars = Array.from(stochasticChars).sort((a, b) => {
    const aReady = (anchorVecsByChar.get(a)?.length ?? 0) >= CENTROID_MIN_N ? 0 : 1;
    const bReady = (anchorVecsByChar.get(b)?.length ?? 0) >= CENTROID_MIN_N ? 0 : 1;
    return aReady - bReady;
  });
  opts?.onRosterKnown?.(orderedChars.length);

  /** Returns the number of `voice-mismatch` rows written for this character
   *  this call — accumulated by the caller into a run-total mismatch count
   *  (round-2 plan-review fix: `scoring_complete`'s `mismatchCount` must be
   *  a real count, not the hardcoded 0 an earlier draft shipped, which
   *  would have permanently logged a false "0 mismatches found" into the
   *  Activity feed via buildScoringCompleteEvent regardless of the actual
   *  result). */
  async function scoreAndMergeCharacter(charId: string, ref: CharacterReference): Promise<number> {
    const configuredEngine = configuredEngineByChar.get(charId) ?? '';
    let mismatchCount = 0;
    for (const cd of chapterData) {
      const rowsForChar: VerdictRow[] = [];
      for (const row of cd.embRows) {
        if (row.characterId !== charId) continue;
        const key = segKey(row.characterId, row.sentenceIds);
        const seg = cd.segsByKey.get(key);
        const renderedFallback = seg?.renderedFallbackEngine ?? null;
        const renderedEngine = (renderedFallback != null && renderedFallback !== '') ? renderedFallback : configuredEngine;

        if (ref.referenceKind === 'too-short') {
          rowsForChar.push({
            characterId: row.characterId, sentenceIds: row.sentenceIds, verdict: 'inconclusive',
            cosine: 0, severity: 'inconclusive', fixable: false,
            expectedEngine: configuredEngine, renderedEngine, referenceKind: 'too-short', windowed: false, chapterId: cd.id,
          });
          continue;
        }
        const cosine = cosineToCentroid(Array.from(row.vec), ref.centroid);
        const { verdict, severity } = scoreSegment(cosine, ref, ASSUMED_DURATION_SEC);
        const fixable = verdict === 'voice-mismatch' && severity === 'severe' && STOCHASTIC_ENGINES.has(configuredEngine);
        if (verdict === 'voice-mismatch') mismatchCount++;
        rowsForChar.push({
          characterId: row.characterId, sentenceIds: row.sentenceIds, verdict, cosine, severity, fixable,
          expectedEngine: configuredEngine, renderedEngine, referenceKind: ref.referenceKind, windowed: false, chapterId: cd.id,
        });
      }
      if (rowsForChar.length === 0) continue;
      await mergeVerdictRows(join(root, `${cd.slug}.render-integrity.json`), charId, rowsForChar);
    }
    return mismatchCount;
  }

  let scoredCount = 0;
  let totalMismatches = 0;
  for (const charId of orderedChars) {
    const anchorVecs = anchorVecsByChar.get(charId)!;
    const persisted = centroidsMap[charId];

    const outcome = await resolveCharacterReference(
      anchorVecs,
      voiceInfoByChar.get(charId),
      persisted,
      { synthFn: opts?.__testSynthFn, embedFn: opts?.__testEmbedFn },
    );

    if (outcome.status === 'transient-failure') {
      const prior = pendingMap[charId] ?? 0;
      if (prior + 1 < MAX_PENDING_ATTEMPTS) {
        pendingMap[charId] = prior + 1;
        continue; // genuinely unresolved this run — nothing written, retried next trigger
      }
      delete pendingMap[charId];
      centroidsMap[charId] = { characterId: charId, ...TOO_SHORT_REF };
      await writeCentroids(bookDir, Object.values(centroidsMap));
      totalMismatches += await scoreAndMergeCharacter(charId, TOO_SHORT_REF);
      scoredCount++;
      opts?.onCharacterScored?.(charId, scoredCount, orderedChars.length);
      continue;
    }

    delete pendingMap[charId];
    centroidsMap[charId] = { characterId: charId, ...outcome.ref };
    await writeCentroids(bookDir, Object.values(centroidsMap));
    totalMismatches += await scoreAndMergeCharacter(charId, outcome.ref);
    scoredCount++;
    opts?.onCharacterScored?.(charId, scoredCount, orderedChars.length);
  }

  await writePendingAttempts(bookDir, pendingMap);

  const usedQwenTiers = { keep06: false, keep17: false };
  for (const info of voiceInfoByChar.values()) {
    if (info.modelKey === 'qwen3-tts-0.6b') usedQwenTiers.keep06 = true;
    if (info.modelKey === 'qwen3-tts-1.7b') usedQwenTiers.keep17 = true;
  }
  return { usedQwenTiers, mismatchCount: totalMismatches };
}


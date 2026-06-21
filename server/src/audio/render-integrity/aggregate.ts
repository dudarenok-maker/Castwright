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
import { audioDir } from '../../workspace/paths.js';
import { readEmbeddings, type EmbeddingRow } from './embeddings-io.js';
import { writeVerdicts, type VerdictRow } from './verdicts-io.js';
import {
  writeCentroids,
  type CharacterCentroid,
} from './centroids-io.js';
import { buildCentroid } from './centroid.js';
import {
  cosineToCentroid,
  percentile,
  scoreSegment,
  CUTOFFS,
} from './score.js';

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
  segments?: SegmentsEntry[];
  characterSnapshots?: Record<string, { voiceEngine?: string; renderedFallbackEngine?: string }>;
}

/** Stochastic engines (Kokoro-configured characters are skipped). */
const STOCHASTIC_ENGINES = new Set(['qwen', 'coqui']);

// ── Reference resolution (Task 10 seam) ───────────────────────────────────

interface CharacterReference {
  centroid: number[];
  cleanMean: number;
  pSevere: number;
  pBand: number;
  referenceKind: 'in-book' | 'audition' | 'too-short';
}

/**
 * Resolve the centroid reference for a character.
 *
 * In-book path (kind='in-book', !bimodal): compute the character's centroid
 * from anchor-eligible vectors, derive the clean spread statistics.
 *
 * Task 10 seam: the too-thin / bimodal branch currently returns
 * `referenceKind: 'too-short'` with an empty centroid (segments → inconclusive).
 * Task 10 replaces this branch with the audition-centroid (Option-B) path,
 * which fetches a pre-recorded audition embedding and uses that as the reference.
 * The function signature and return type are stable — Task 10 only replaces the
 * else-branch body.
 */
function resolveCharacterReference(
  anchorVecs: Float32Array[],
): CharacterReference {
  const result = buildCentroid(anchorVecs);

  if (result.kind === 'in-book' && !result.bimodal) {
    // In-book path: compute the clean spread over the anchor-eligible set.
    const centroidArr = Array.from(result.centroid);
    const cosines = anchorVecs
      .map((v) => cosineToCentroid(Array.from(v), centroidArr))
      .sort((a, b) => a - b);

    const cleanMean = cosines.reduce((s, c) => s + c, 0) / cosines.length;
    const pSevere = percentile(cosines, CUTOFFS.severeEdgePctl);
    const pBand = percentile(cosines, CUTOFFS.bandUpperPctl);

    return {
      centroid: centroidArr,
      cleanMean,
      pSevere,
      pBand,
      referenceKind: 'in-book',
    };
  }

  // Task 10 seam: too-thin OR bimodal → Option-B audition centroid (not yet implemented).
  // For now: return a placeholder that causes all segments to score 'inconclusive'.
  // Task 10 replaces this branch with the real audition-centroid lookup.
  return {
    centroid: [],
    cleanMean: 0,
    pSevere: 0,
    pBand: 0,
    referenceKind: 'too-short',
  };
}

// ── Per-chapter segment lookup ─────────────────────────────────────────────

/** Read a single segments file; returns null on missing/parse error. */
async function readSegmentsFile(path: string): Promise<SegmentsFileView | null> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as SegmentsFileView;
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return null;
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
 * Idempotent — safe to re-run; files are overwritten each call.
 *
 * @param bookDir  The book's root directory on disk.
 * @param chapters Array of `{ id, slug }` identifying the book's chapters.
 */
export async function scoreBook(
  bookDir: string,
  chapters: { id: number; slug: string }[],
): Promise<void> {
  const root = audioDir(bookDir);

  // ── Phase 1: Collect per-chapter embeddings + segments ─────────────────

  type ChapterData = {
    slug: string;
    embRows: EmbeddingRow[];
    segsByKey: Map<string, SegmentsEntry>;
    snapshots: Record<string, { voiceEngine?: string }>;
  };

  const chapterData: ChapterData[] = [];

  for (const ch of chapters) {
    const embPath = join(root, `${ch.slug}.embeddings.json`);
    const segPath = join(root, `${ch.slug}.segments.json`);

    const embResult = await readEmbeddings(embPath);
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
      slug: ch.slug,
      embRows: embResult.rows,
      segsByKey,
      snapshots: segFile.characterSnapshots ?? {},
    });
  }

  // No chapter data → nothing to do
  if (chapterData.length === 0) return;

  // ── Phase 2: Gather anchor-eligible vectors per character ───────────────

  // Collect all character IDs and their configured engines (from characterSnapshots).
  // First chapter's snapshot wins — a mid-book engine re-cast would mislabel, but
  // embeddings would be re-generated on re-render, making this acceptable.
  const configuredEngineByChar = new Map<string, string>();
  for (const cd of chapterData) {
    for (const [charId, snap] of Object.entries(cd.snapshots)) {
      if (!configuredEngineByChar.has(charId) && snap.voiceEngine) {
        configuredEngineByChar.set(charId, snap.voiceEngine);
      }
    }
  }

  // Filter to stochastic characters only
  const stochasticChars = new Set<string>();
  for (const [charId, engine] of configuredEngineByChar) {
    if (STOCHASTIC_ENGINES.has(engine)) stochasticChars.add(charId);
  }

  if (stochasticChars.size === 0) return; // No stochastic characters → nothing to score

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

  // ── Phase 3: Build centroids + compute per-character spread ────────────

  const characterCentroids = new Map<string, CharacterReference>();
  const centroidRows: CharacterCentroid[] = [];

  for (const charId of stochasticChars) {
    const anchorVecs = anchorVecsByChar.get(charId)!;
    const ref = resolveCharacterReference(anchorVecs);
    characterCentroids.set(charId, ref);
    centroidRows.push({
      characterId: charId,
      centroid: ref.centroid,
      cleanMean: ref.cleanMean,
      pSevere: ref.pSevere,
      pBand: ref.pBand,
      referenceKind: ref.referenceKind,
    });
  }

  // Persist centroids (repair route reads them in Task 13)
  await writeCentroids(bookDir, centroidRows);

  // ── Phase 4: Score every chapter's embedding rows ──────────────────────

  for (const cd of chapterData) {
    const verdictRows: VerdictRow[] = [];

    for (const row of cd.embRows) {
      if (!stochasticChars.has(row.characterId)) continue;

      const ref = characterCentroids.get(row.characterId);
      if (!ref) continue;

      const configuredEngine = configuredEngineByChar.get(row.characterId) ?? '';
      const key = segKey(row.characterId, row.sentenceIds);
      const seg = cd.segsByKey.get(key);
      const renderedFallback = seg?.renderedFallbackEngine ?? null;
      const renderedEngine = (renderedFallback != null && renderedFallback !== '') ? renderedFallback : configuredEngine;

      // Too-short placeholder: segments → inconclusive
      if (ref.referenceKind === 'too-short') {
        verdictRows.push({
          characterId: row.characterId,
          sentenceIds: row.sentenceIds,
          verdict: 'inconclusive',
          cosine: 0,
          severity: 'inconclusive',
          fixable: false,
          expectedEngine: configuredEngine,
          renderedEngine,
          referenceKind: 'too-short',
          windowed: false,
        });
        continue;
      }

      // Acoustic scoring against the character's centroid.
      // ALL embedded segments — including fallback renders — are scored acoustically
      // per spec §4.1. Fallback segments usually flag (Kokoro timbre is far from a
      // Qwen centroid → low cosine → voice-mismatch), but via the real metric.
      // The stored `cosine` is always the real measurement (Task 13 reads it).
      const cosine = cosineToCentroid(Array.from(row.vec), ref.centroid);
      const { verdict, severity } = scoreSegment(cosine, ref, ASSUMED_DURATION_SEC);

      const fixable = verdict === 'voice-mismatch' && severity === 'severe'
        && STOCHASTIC_ENGINES.has(configuredEngine);

      verdictRows.push({
        characterId: row.characterId,
        sentenceIds: row.sentenceIds,
        verdict,
        cosine,
        severity,
        fixable,
        expectedEngine: configuredEngine,
        renderedEngine,
        referenceKind: ref.referenceKind,
        windowed: false,
      });
    }

    if (verdictRows.length === 0) continue;

    const verdictPath = join(root, `${cd.slug}.render-integrity.json`);
    await writeVerdicts(verdictPath, verdictRows);
  }
}


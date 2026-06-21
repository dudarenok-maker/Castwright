/* Audio-QA repair — scan an ALREADY-rendered chapter for bad sentences and
   re-record just those, in place.

   The pre-assembly gate (segment-qa.ts in synthesise-chapter.ts) protects new
   generations, but chapters rendered before it landed (or before their bad
   sentences were caught) are already on disk. This route runs the SAME
   per-sentence QA — dead/near-silence, a long internal silence run, duration
   drift — over each segment's decoded PCM, then:

     - dry-run  → returns the scan (which sentences would be re-recorded), no
                  GPU, no write. Lets the user see what a chapter would repair
                  before spending synth time.
     - repair   → re-synthesises the flagged sentences (best-of-N, re-QA'd),
                  splices them back with `spliceChapterSegments`, and writes via
                  `finalizeChapterAudioWrite` (same encode + loudnorm + atomic
                  `.previous.*` rollback tail as generation and fs-26 splice).

   Reuses the fs-26 splice machinery end to end — this is effectively the
   `rerecord` splice with its target sentences chosen by QA instead of by hand. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateAudioFormat, bookStateLanguage, type BookStateJson } from '../workspace/scan.js';
import { castJsonPath, audioDir, manuscriptEditsJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import {
  engineForModelKey,
  isTtsModelKey,
  selectTtsProvider,
  type TtsEngine,
  type TtsModelKey,
  type TtsProvider,
} from '../tts/index.js';
import { decodeAudioToPcm } from '../tts/mp3.js';
import { hydrateCastReusedVoices } from '../tts/hydrate-reused-voice-workspace.js';
import { synthesiseChapter, type CastCharacter, type ChapterSegment } from '../tts/synthesise-chapter.js';
import { evaluateSegmentPcm, type SegmentQaVerdict } from '../tts/segment-qa.js';
import {
  verifySegmentTranscript,
  asrEnabled,
  buildCastNameAllowlist,
  type AsrClassification,
} from '../tts/segment-asr-qa.js';
import { resolveCharacterEngine } from '../tts/per-character-engine.js';
import { isNonEnglish } from '../tts/language.js';
import { getLastKnownQwenInstallState } from '../workspace/user-settings.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { rebuildCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import { spliceChapterSegments, secToByteOffset, type SegmentReplacement } from '../audio/splice-chapter.js';
import { buildSynthReplacements, isRerecordableSegment } from '../audio/build-synth-replacement.js';
import { finalizeChapterAudioWrite, type ChapterSegmentsFile } from '../audio/finalize-chapter-write.js';
import { abortInFlightChapterJob } from './generation.js';
import { registerSplice } from './chapter-job-coordination.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { configValue } from '../config/resolver.js';
import { readVerdicts, writeVerdicts } from '../audio/render-integrity/verdicts-io.js';
import { readCentroids, type CharacterCentroid } from '../audio/render-integrity/centroids-io.js';
import { cosineToCentroid } from '../audio/render-integrity/score.js';
import { embedSegment } from '../tts/embed-client.js';
import { readEmbeddings, writeEmbeddings, EMBEDDINGS_VERSION, type EmbeddingRow } from '../audio/render-integrity/embeddings-io.js';

export const chapterQaRepairRouter = Router();

interface QaRepairRequestBody {
  dryRun?: unknown;
  modelKey?: unknown;
  maxRerecords?: unknown;
}

/** `ok` beats `suspect`; among two suspects, fewer reasons is less-bad. */
function isBetter(a: SegmentQaVerdict, b: SegmentQaVerdict): boolean {
  if (a.status !== b.status) return a.status === 'ok';
  return a.reasons.length < b.reasons.length;
}

function resolveMaxRerecords(raw: unknown): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  const env = Number(process.env.SEG_QA_MAX_RERECORDS);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : 2;
}

chapterQaRepairRouter.post(
  '/:bookId/chapters/:chapterId/audio-qa-repair',
  async (req: Request, res: Response) => {
    const { bookId } = req.params;
    const chapterId = Number(req.params.chapterId);
    const body = (req.body ?? {}) as QaRepairRequestBody;
    const dryRun = body.dryRun !== false; // default to the safe read-only scan

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    const fail = (errorReason: string) => {
      send({ type: 'chapter_failed', chapterId, errorReason });
      res.end();
    };

    if (!Number.isInteger(chapterId)) return fail('chapterId must be an integer.');

    const located = await findBookByBookId(bookId);
    if (!located) return fail(`No book found for id "${bookId}".`);
    const { bookDir, state } = located;

    const chapter = state.chapters.find((c) => c.id === chapterId);
    if (!chapter) return fail(`No chapter ${chapterId} in book "${bookId}".`);

    const audioRoot = audioDir(bookDir);
    const audioFile = findChapterAudio(audioRoot, chapter.slug);
    if (!audioFile) return fail('Chapter has no rendered audio to repair — generate it first.');

    const segPath = join(audioRoot, `${chapter.slug}.segments.json`);
    const segFile = await readJson<ChapterSegmentsFile>(segPath).catch(() => null);
    if (!segFile || !Array.isArray(segFile.segments) || !segFile.segments.length) {
      return fail('Chapter segments metadata is missing or unreadable — re-render the chapter.');
    }

    const controller = new AbortController();
    let releaseSlot: (() => void) | null = null;
    try {
      const sampleRate = segFile.sampleRate;
      const decodedPcm = await decodeAudioToPcm(await readFile(audioFile.path), sampleRate);

      /* Sentence text per id (best-effort) — drives the duration-drift check.
         Absent cache only weakens that one signal; the silence/RMS checks still
         flag dead segments. */
      const idToText = new Map<number, string>();
      try {
        const analysis = await loadAnalysisCache(state.manuscriptId);
        for (const s of analysis.chapters?.[chapterId] ?? []) idToText.set(s.id, s.text);
      } catch {
        /* no cache — duration check degrades gracefully */
      }
      const segText = (seg: ChapterSegment): string =>
        seg.sentenceIds.map((id) => idToText.get(id) ?? '').join(' ').trim();

      /* ASR content-QA setup (srv-31) — OFF unless SEG_ASR_ENABLED. The scan
         adds a transcript word-error-rate check on top of the signal scan so a
         "fluent but wrong words" segment (which the signal checks can't see) is
         also flagged for re-record. Cast names form the proper-noun allowlist;
         a non-English book passes its language hint. */
      const asrOn = asrEnabled();
      const repairLanguage = bookStateLanguage(state);
      const asrLanguage = isNonEnglish(repairLanguage) ? repairLanguage : undefined;
      let asrAllowlist: string[] = [];
      if (asrOn) {
        const castNames = await readJson<{ characters?: { name?: string; aliases?: string[] }[] }>(
          castJsonPath(bookDir),
        ).catch(() => null);
        asrAllowlist = buildCastNameAllowlist(castNames?.characters ?? []);
      }
      const verifyAsr = (pcm: Buffer, text: string): Promise<AsrClassification> =>
        verifySegmentTranscript(pcm, sampleRate, text, {
          language: asrLanguage,
          nameAllowlist: asrAllowlist,
          signal: controller.signal,
        });

      /* Scan every sentence-backed segment (skip the title beat). */
      const flagged: Array<{
        segmentIndex: number;
        characterId: string;
        sentenceIds: number[];
        reasons: string[];
        acoustic?: boolean;
      }> = [];
      for (let i = 0; i < segFile.segments.length; i += 1) {
        const seg = segFile.segments[i];
        if (!isRerecordableSegment(seg)) continue;
        const start = secToByteOffset(seg.startSec, sampleRate, decodedPcm.length);
        const end = secToByteOffset(seg.endSec, sampleRate, decodedPcm.length);
        const pcmSeg = decodedPcm.subarray(start, end);
        const text = segText(seg);
        const verdict = evaluateSegmentPcm(pcmSeg, sampleRate, text);
        if (verdict.status === 'suspect') {
          flagged.push({
            segmentIndex: i,
            characterId: seg.characterId,
            sentenceIds: seg.sentenceIds.slice(),
            reasons: verdict.reasons,
          });
          continue; // already flagged by the cheap signal scan — skip ASR
        }
        /* Signal-clean → check content (the fluent-but-wrong case). */
        if (asrOn && text) {
          const a = await verifyAsr(pcmSeg, text);
          if (a.verdict === 'drift') {
            flagged.push({
              segmentIndex: i,
              characterId: seg.characterId,
              sentenceIds: seg.sentenceIds.slice(),
              reasons: a.reasons,
            });
          }
        }
      }

      /* Edit 1 (srv-36): merge acoustic candidates from the sibling render-integrity
         verdict file. Gate on qa.speaker.autoRepair — detection surfacing comes from
         Task 11 (deriveBookOutline), not this route; this gate only covers the FIX path.
         Dedupes by segmentIndex: if the signal/ASR scan already flagged a segment,
         UNION (set acoustic: true on the existing entry) rather than adding a duplicate. */
      if (configValue('qa.speaker.autoRepair')) {
        const verdictPath = join(audioRoot, `${chapter.slug}.render-integrity.json`);
        const verdictRows = await readVerdicts(verdictPath).catch(() => null);
        if (verdictRows) {
          for (const row of verdictRows) {
            if (row.verdict !== 'voice-mismatch' || !row.fixable) continue;
            // segmentIndex may live on the verdict row (added by aggregate/repair); fall
            // back to matching by sentenceIds against the segments file.
            const segIdx =
              (row as { segmentIndex?: number }).segmentIndex ??
              segFile.segments.findIndex(
                (s) => s.sentenceIds.length > 0 && row.sentenceIds.every((id) => s.sentenceIds.includes(id)),
              );
            if (segIdx < 0) continue;
            const existing = flagged.find((f) => f.segmentIndex === segIdx);
            if (existing) {
              // Union: the signal/ASR scan already covers this segment; mark it acoustic too.
              existing.acoustic = true;
            } else {
              flagged.push({
                segmentIndex: segIdx,
                characterId: row.characterId,
                sentenceIds: row.sentenceIds.slice(),
                reasons: [`voice-mismatch cosine ${row.cosine.toFixed(3)} < E (fixable)`],
                acoustic: true,
              });
            }
          }
        }
      }

      send({ type: 'qa_scan', chapterId, flaggedCount: flagged.length, flagged });

      if (dryRun || flagged.length === 0) {
        send({ type: 'qa_repair_complete', chapterId, dryRun, flagged, repaired: [] });
        return res.end();
      }

      /* --- Repair path (GPU): re-record the flagged sentences. --- */
      const modelKey: TtsModelKey | null = isTtsModelKey(body.modelKey)
        ? body.modelKey
        : isTtsModelKey(segFile.modelKey)
          ? (segFile.modelKey as TtsModelKey)
          : null;
      if (!modelKey) return fail('modelKey must be a supported voice-engine model id to repair.');
      const maxRerecords = resolveMaxRerecords(body.maxRerecords);

      const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
      if (!cast?.characters?.length) return fail('Cast not confirmed yet — open the cast view first.');
      cast.characters = await hydrateCastReusedVoices(cast.characters);

      /* Displace any in-flight regen of this chapter, and register so a later
         regen displaces us — the two never race the same files. */
      abortInFlightChapterJob(bookId, chapterId);
      releaseSlot = registerSplice(bookId, chapterId, controller);

      send({ type: 'splice_start', chapterId, mode: 'qa-repair' });

      const engine = engineForModelKey(modelKey);
      const provider = selectTtsProvider(modelKey);

      /* Per-character engine routing (plan 108), mirrored from the splice route. */
      const providerCache = new Map<TtsEngine, { provider: TtsProvider; modelKey: TtsModelKey }>();
      providerCache.set(engine, { provider, modelKey });
      const canonicalModelKeyForEngine = (e: TtsEngine): TtsModelKey => {
        switch (e) {
          case 'kokoro':
            return 'kokoro-v1';
          case 'qwen':
            return 'qwen3-tts-0.6b';
          case 'coqui':
            return 'coqui-xtts-v2';
          case 'piper':
            return 'piper-en-us-medium';
          case 'gemini':
            return modelKey.startsWith('gemini-') ? modelKey : 'gemini-2.5-flash';
        }
      };
      const resolveForEngine = (e: TtsEngine): { provider: TtsProvider; modelKey: TtsModelKey } => {
        const cached = providerCache.get(e);
        if (cached) return cached;
        const mk = canonicalModelKeyForEngine(e);
        const built = { provider: selectTtsProvider(mk), modelKey: mk };
        providerCache.set(e, built);
        return built;
      };

      const bookLanguage = bookStateLanguage(state);
      const nonEnglishBook = isNonEnglish(bookLanguage);
      if (nonEnglishBook) for (const c of cast.characters) c.ttsEngine = 'qwen';
      const requiredEngines = new Set(cast.characters.map((c) => resolveCharacterEngine(c, engine)));
      const qwenInUse = requiredEngines.has('qwen');
      const qwenState = getLastKnownQwenInstallState();
      const qwenUnavailable = qwenInUse && qwenState !== 'ready' && qwenState !== 'loaded';

      /* Sentences from the same source generation uses; rebuild from edits first
         so a re-record matches the last rendered text. */
      const editsPath = manuscriptEditsJsonPath(bookDir);
      const editsSnapshot = await readJson<{ sentences?: unknown[] }>(editsPath).catch(() => null);
      if (Array.isArray(editsSnapshot?.sentences) && editsSnapshot.sentences.length > 0) {
        await rebuildCacheFromEdits(state.manuscriptId, editsPath).catch(() => {});
      }
      const analysis = await loadAnalysisCache(state.manuscriptId);
      const sentences = analysis.chapters?.[chapterId] ?? [];
      if (!sentences.length) {
        return fail('No analysed sentences cached for this chapter — re-run analysis first.');
      }

      const stillSuspect: number[] = [];
      const repaired: number[] = [];

      /* Edit 3 (srv-36): load per-character centroids once for the acoustic
         accept-check inside the synth callback. Null when no centroid file exists
         yet (scoredBook hasn't run) — the acoustic gate then applies no cosine
         constraint (safe: a centroid-less character can't have a fixable verdict). */
      const centroids: Record<string, CharacterCentroid> | null = await readCentroids(bookDir).catch(() => null);

      /* Edit 6 (srv-36): capture accepted re-render embeddings by segment index.
         Populated inside the synth callback; flushed to disk after finalize. */
      const newEmbeddingsByIndex = new Map<number, Float32Array>();

      /* Edit 2 pre-filter (srv-36): for acoustic-only candidates, skip ones whose
         engine is unavailable or whose character has no usable centroid. Mark them
         inconclusive up front so they don't reach the re-render path. */
      const targetIndices: number[] = [];
      for (const f of flagged) {
        if (f.acoustic) {
          const charCentroid = centroids?.[f.characterId];
          if (!charCentroid || charCentroid.referenceKind === 'too-short') {
            // No usable centroid — defensive skip.
            stillSuspect.push(f.segmentIndex);
            continue;
          }
          const seg = segFile.segments[f.segmentIndex];
          const charEngine = seg
            ? resolveCharacterEngine(
                cast.characters.find((c) => c.id === seg.characterId) ?? {},
                engine,
              )
            : engine;
          const engineUnavailable = charEngine === 'qwen' ? qwenUnavailable : false;
          if (engineUnavailable) {
            stillSuspect.push(f.segmentIndex);
            continue;
          }
        }
        targetIndices.push(f.segmentIndex);
      }

      const replacements: SegmentReplacement[] = await buildSynthReplacements({
        segments: segFile.segments,
        targetIndices,
        chapterSampleRate: sampleRate,
        synth: async (seg) => {
          const segIndex = segFile.segments.indexOf(seg);
          const candidate = flagged.find((f) => f.segmentIndex === segIndex);

          const ids = new Set(seg.sentenceIds);
          const subset = sentences.filter((s) => ids.has(s.id));
          const text = segText(seg);
          let best: { pcm: Buffer; sampleRate: number } | null = null;
          let bestVerdict: SegmentQaVerdict | null = null;
          let bestAsr: AsrClassification | null = null;
          /* Edit 3b (srv-36): extend running best-state with bestCosine. */
          let bestCosine: number | null = null;

          /* Edit 5 (srv-36): extend isAcceptable with the conditional acoustic term.
             The acoustic gate ONLY applies when candidate.acoustic === true AND a
             centroid exists for the character. For signal/ASR-only candidates the
             predicate is UNCHANGED — a pure signal repair must not be rejected
             because its cosine is low, and a character without a centroid must not
             be gated at all. */
          const isAcceptable = (
            v: SegmentQaVerdict | null,
            a: AsrClassification | null,
            cos: number | null,
            cand: typeof candidate,
          ): boolean => {
            const signalAndAsrOk =
              v != null && v.status === 'ok' && (!asrOn || a == null || a.verdict !== 'drift');
            if (!signalAndAsrOk) return false;
            // Apply acoustic term only when the candidate originated from the verdict file
            // AND a centroid is available for this character.
            if (cand?.acoustic && cos !== null && centroids?.[seg.characterId]) {
              const charCentroid = centroids[seg.characterId];
              return cos >= charCentroid.cleanMean;
            }
            return true;
          };

          for (let attempt = 1; attempt <= maxRerecords; attempt++) {
            if (controller.signal.aborted) break;
            send({ type: 'progress', chapterId, segmentIndex: segIndex, attempt, progress: 0.5 });
            const r = await synthesiseChapter({
              sentences: subset,
              cast: cast.characters,
              provider,
              modelKey,
              engine,
              resolveForEngine,
              qwenUnavailable,
              forbidKokoroFallback: nonEnglishBook,
              bookLanguage,
              signal: controller.signal,
              chapterTitleNarration: undefined,
              narratorCharacterId: 'narrator',
            });
            const v = evaluateSegmentPcm(r.pcm, r.sampleRate, text);
            const a = asrOn && text ? await verifyAsr(r.pcm, text) : null;
            /* Edit 4 (srv-36): embed the pre-resample/pre-loudnorm PCM for the
               acoustic accept-check. Only embed when the candidate is acoustic AND a
               centroid exists for this character — avoid the sidecar round-trip for
               pure signal/ASR repairs. */
            let cos: number | null = null;
            if (candidate?.acoustic && centroids?.[seg.characterId]) {
              const vec = Array.from(await embedSegment(r.pcm, r.sampleRate));
              cos = cosineToCentroid(vec, centroids[seg.characterId].centroid);
            }
            const better =
              !best ||
              bestVerdict == null ||
              (isAcceptable(v, a, cos, candidate) && !isAcceptable(bestVerdict, bestAsr, bestCosine, candidate)) ||
              (isAcceptable(v, a, cos, candidate) === isAcceptable(bestVerdict, bestAsr, bestCosine, candidate) &&
                isBetter(v, bestVerdict));
            if (better) {
              best = { pcm: r.pcm, sampleRate: r.sampleRate };
              bestVerdict = v;
              bestAsr = a;
              bestCosine = cos;
            }
            if (isAcceptable(bestVerdict, bestAsr, bestCosine, candidate)) break;
          }
          if (!best) throw new Error('Re-record produced no audio.');
          const accepted = isAcceptable(bestVerdict, bestAsr, bestCosine, candidate);
          if (!accepted) {
            stillSuspect.push(segIndex);
          } else {
            repaired.push(segIndex);
            /* Edit 6a (srv-36): capture the accepted take's embedding for post-finalize write. */
            if (bestCosine !== null && candidate?.acoustic && centroids?.[seg.characterId]) {
              // We already have the last-computed embedding via embedSegment — but to avoid
              // storing a reference to the Float32Array from the last loop iteration (which
              // may be the best or the last non-best), recompute from `best.pcm`.
              try {
                const vec = await embedSegment(best.pcm, best.sampleRate);
                newEmbeddingsByIndex.set(segIndex, vec);
              } catch {
                /* non-fatal — the repair succeeded; the sibling update is best-effort */
              }
            }
          }
          return best;
        },
      });

      if (controller.signal.aborted) {
        return fail('Repair was displaced by another job for this chapter.');
      }

      const spliced = spliceChapterSegments({
        decodedPcm,
        sampleRate,
        segments: segFile.segments,
        replacements,
      });

      send({ type: 'chapter_assembling', chapterId, progress: 0.99 });

      const result = await finalizeChapterAudioWrite({
        bookId,
        bookDir,
        chapter: { id: chapter.id, slug: chapter.slug, title: chapter.title },
        pcm: spliced.pcm,
        sampleRate: spliced.sampleRate,
        durationSec: spliced.durationSec,
        segments: spliced.segments,
        cast: cast.characters,
        defaultEngine: engine,
        modelKey,
        audioFormat: bookStateAudioFormat(state as BookStateJson),
        expectedSec: segFile.durationSec,
      });

      /* Edit 6b (srv-36): for accepted acoustic takes, write their new embeddings
         into the <slug>.embeddings.json sibling and update the corresponding rows
         in <slug>.render-integrity.json. Both are best-effort — a failure here must
         not abort the repair that already succeeded. */
      if (newEmbeddingsByIndex.size > 0) {
        try {
          const embPath = join(audioRoot, `${chapter.slug}.embeddings.json`);
          const existing = await readEmbeddings(embPath).catch(() => null);
          const existingRows: EmbeddingRow[] = existing?.rows ?? [];

          // Replace or append rows for the repaired segments.
          for (const [segIdx, vec] of newEmbeddingsByIndex) {
            const seg = segFile.segments[segIdx];
            if (!seg) continue;
            const rowIdx = existingRows.findIndex(
              (r) => r.characterId === seg.characterId && r.sentenceIds.join(',') === seg.sentenceIds.join(','),
            );
            const newRow: EmbeddingRow = { characterId: seg.characterId, sentenceIds: seg.sentenceIds.slice(), vec };
            if (rowIdx >= 0) {
              existingRows[rowIdx] = newRow;
            } else {
              existingRows.push(newRow);
            }
          }
          await writeEmbeddings(embPath, existingRows, EMBEDDINGS_VERSION);
        } catch {
          /* non-fatal */
        }

        try {
          const verdictPath = join(audioRoot, `${chapter.slug}.render-integrity.json`);
          const verdictRows = await readVerdicts(verdictPath).catch(() => null);
          if (verdictRows) {
            for (const [segIdx, vec] of newEmbeddingsByIndex) {
              const seg = segFile.segments[segIdx];
              if (!seg || !centroids?.[seg.characterId]) continue;
              const centroid = centroids[seg.characterId];
              const newCosine = cosineToCentroid(Array.from(vec), centroid.centroid);
              // Update the verdict row that matches this segment's sentenceIds.
              const vRowIdx = verdictRows.findIndex(
                (r) => r.sentenceIds.length > 0 && seg.sentenceIds.every((id) => r.sentenceIds.includes(id)),
              );
              if (vRowIdx >= 0) {
                verdictRows[vRowIdx] = {
                  ...verdictRows[vRowIdx],
                  cosine: newCosine,
                  verdict: newCosine >= centroid.pBand ? 'voice-match' : newCosine >= centroid.pSevere ? 'inconclusive' : 'voice-mismatch',
                  severity: newCosine >= centroid.pBand ? null : newCosine >= centroid.pSevere ? 'inconclusive' : 'severe',
                  fixable: newCosine < centroid.pSevere,
                };
              }
            }
            await writeVerdicts(verdictPath, verdictRows);
          }
        } catch {
          /* non-fatal */
        }
      }

      send({
        type: 'qa_repair_complete',
        chapterId,
        dryRun: false,
        flagged,
        repaired,
        stillSuspect,
        durationSec: result.durationSec,
        segmentCount: result.segmentCount,
        hasPreviousAudio: true,
      });
      res.end();
    } catch (err) {
      fail(`Audio-QA repair failed: ${(err as Error).message}`);
    } finally {
      releaseSlot?.();
    }
  },
);

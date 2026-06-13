/* fs-26 — per-character re-record / splice.

   Re-renders or re-mixes ONE character's segments in an already-rendered
   chapter and splices the result back into the chapter audio, instead of
   regenerating the whole chapter. Two modes share one engine:

     - `remix`    — apply a dB gain to the character's existing segments
                    (ffmpeg `volume`, no GPU). The fix for "too quiet": a
                    relative boost survives the whole-chapter loudnorm re-pass.
     - `rerecord` — re-synthesise the character's sentences (GPU) and splice.

   Flow: decode the chapter audio → build a per-run replacement PCM →
   `spliceChapterSegments` (byte-range surgery + retiming) →
   `finalizeChapterAudioWrite` (encode + loudnorm + preserve `.previous.*` +
   atomic write + state.json). SSE response mirrors the generation route so the
   frontend reuses its stream client. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId, bookStateAudioFormat, type BookStateJson } from '../workspace/scan.js';
import { castJsonPath, audioDir } from '../workspace/paths.js';
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
import { pcmDurationSec } from '../tts/pcm.js';
import { applyGainToPcm } from '../tts/gain-pcm.js';
import { hydrateCastReusedVoices } from '../tts/hydrate-reused-voice-workspace.js';
import { synthesiseChapter, type CastCharacter } from '../tts/synthesise-chapter.js';
import { resolveCharacterEngine } from '../tts/per-character-engine.js';
import { isNonEnglish, sidecarLanguageName } from '../tts/language.js';
import { clearMismatchedDesignedVoices } from '../tts/verify-designed-voice-language.js';
import { getLastKnownQwenInstallState } from '../workspace/user-settings.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { rebuildCacheFromEdits } from '../store/analysis-cache-rebuild.js';
import { manuscriptEditsJsonPath } from '../workspace/paths.js';
import { bookStateLanguage } from '../workspace/scan.js';
import {
  spliceChapterSegments,
  secToByteOffset,
  type SegmentReplacement,
} from '../audio/splice-chapter.js';
import { buildSynthReplacements, isRerecordableSegment } from '../audio/build-synth-replacement.js';
import {
  finalizeChapterAudioWrite,
  type ChapterSegmentsFile,
} from '../audio/finalize-chapter-write.js';
import { abortInFlightChapterJob } from './generation.js';
import { registerSplice } from './chapter-job-coordination.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export const chapterSpliceRouter = Router();

/** Clamp range for a per-character gain (dB). Generous enough to rescue a very
    quiet voice, bounded so a fat-fingered value can't blow out the chapter. */
const GAIN_DB_MIN = -24;
const GAIN_DB_MAX = 24;

interface SpliceRequestBody {
  mode?: unknown;
  characterId?: unknown;
  gainDb?: unknown;
  segmentIndices?: unknown;
  modelKey?: unknown;
}

/** Collapse a sorted list of segment indices into contiguous runs. */
function toRuns(indices: number[]): Array<{ start: number; end: number }> {
  const runs: Array<{ start: number; end: number }> = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && i === last.end + 1) last.end = i;
    else runs.push({ start: i, end: i });
  }
  return runs;
}

chapterSpliceRouter.post(
  '/:bookId/chapters/:chapterId/splice',
  async (req: Request, res: Response) => {
    const { bookId } = req.params;
    const chapterId = Number(req.params.chapterId);
    const body = (req.body ?? {}) as SpliceRequestBody;

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

    const mode = body.mode === 'rerecord' ? 'rerecord' : body.mode === 'remix' ? 'remix' : null;
    if (!mode) return fail("mode must be 'remix' or 'rerecord'.");
    if (typeof body.characterId !== 'string' || !body.characterId) {
      return fail('characterId is required.');
    }
    const characterId = body.characterId;
    if (!Number.isInteger(chapterId)) return fail('chapterId must be an integer.');

    // Mode-specific request validation.
    let gainDb = 0;
    let reqModelKey: TtsModelKey | null = null;
    if (mode === 'remix') {
      gainDb = Number(body.gainDb);
      if (!Number.isFinite(gainDb)) return fail('gainDb must be a finite number for a remix.');
      if (gainDb < GAIN_DB_MIN || gainDb > GAIN_DB_MAX) {
        return fail(`gainDb must be between ${GAIN_DB_MIN} and ${GAIN_DB_MAX} dB.`);
      }
    } else if (!isTtsModelKey(body.modelKey)) {
      return fail('modelKey must be a supported voice-engine model id for a re-record.');
    } else {
      reqModelKey = body.modelKey;
    }

    const located = await findBookByBookId(bookId);
    if (!located) return fail(`No book found for id "${bookId}".`);
    const { bookDir, state } = located;

    const chapter = state.chapters.find((c) => c.id === chapterId);
    if (!chapter) return fail(`No chapter ${chapterId} in book "${bookId}".`);

    const audioRoot = audioDir(bookDir);
    const audioFile = findChapterAudio(audioRoot, chapter.slug);
    if (!audioFile) return fail('Chapter has no rendered audio to splice — generate it first.');

    const segPath = join(audioRoot, `${chapter.slug}.segments.json`);
    const segFile = await readJson<ChapterSegmentsFile>(segPath).catch(() => null);
    if (!segFile || !Array.isArray(segFile.segments) || !segFile.segments.length) {
      return fail('Chapter segments metadata is missing or unreadable — re-render the chapter.');
    }

    let targetIndices = segFile.segments
      .map((s, i) => (s.characterId === characterId ? i : -1))
      .filter((i) => i >= 0);
    if (!targetIndices.length) {
      return fail(`Character "${characterId}" has no segments in this chapter.`);
    }
    /* rerecord may target a subset of the character's segments. Every requested
       index must belong to the character — never let a caller re-record a
       different speaker's line. */
    if (mode === 'rerecord' && Array.isArray(body.segmentIndices)) {
      const owned = new Set(targetIndices);
      const requested = body.segmentIndices.filter(
        (i): i is number => typeof i === 'number' && Number.isInteger(i),
      );
      if (requested.some((i) => !owned.has(i))) {
        return fail('segmentIndices must all belong to the character in this chapter.');
      }
      targetIndices = [...new Set(requested)].sort((a, b) => a - b);
      if (!targetIndices.length) return fail('segmentIndices selected no segments.');
    }
    /* Re-record only re-synthesises sentence-backed segments. Drop the title
       beat (narrator's characterId, empty sentenceIds) so re-recording the
       narrator can't splice silence over the chapter title. Remix (gain) keeps
       the title — boosting the narrator should boost the title beat too. */
    if (mode === 'rerecord') {
      targetIndices = targetIndices.filter((i) => isRerecordableSegment(segFile.segments[i]));
      if (!targetIndices.length) {
        return fail('No re-recordable lines for this character in this chapter (title-only).');
      }
    }

    /* Cast (hydrated like generation) so the rewritten segments file carries
       accurate drift snapshots. */
    const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
    if (!cast?.characters?.length) return fail('Cast not confirmed yet — open the cast view first.');
    cast.characters = await hydrateCastReusedVoices(cast.characters);

    /* Concurrency: displace any in-flight regen of this chapter, and register
       so a later regen displaces us — the two never race the same files. */
    const controller = new AbortController();
    abortInFlightChapterJob(bookId, chapterId);
    const releaseSlot = registerSplice(bookId, chapterId, controller);

    try {
      send({ type: 'splice_start', chapterId, mode, characterId });

      const sampleRate = segFile.sampleRate;
      const decodedPcm = await decodeAudioToPcm(await readFile(audioFile.path), sampleRate);

      let replacements: SegmentReplacement[];
      // The finalize stamp matches what was rendered: remix keeps the chapter's
      // model/engine; rerecord adopts the requested one.
      let finalizeModelKey: TtsModelKey = segFile.modelKey as TtsModelKey;
      let defaultEngine: TtsEngine = engineForModelKey(finalizeModelKey);

      if (mode === 'remix') {
        replacements = [];
        for (const run of toRuns(targetIndices)) {
          const spanStart = secToByteOffset(segFile.segments[run.start].startSec, sampleRate, decodedPcm.length);
          const spanEnd = secToByteOffset(segFile.segments[run.end].endSec, sampleRate, decodedPcm.length);
          const slice = decodedPcm.subarray(spanStart, spanEnd);
          const gained = await applyGainToPcm(slice, sampleRate, gainDb);
          replacements.push({ startSegmentIndex: run.start, endSegmentIndex: run.end, pcm: gained });
        }
      } else {
        const modelKey = reqModelKey!;
        const engine = engineForModelKey(modelKey);
        const provider = selectTtsProvider(modelKey);
        finalizeModelKey = modelKey;
        defaultEngine = engine;

        /* Per-character engine routing (plan 108), mirrored from generation. */
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

        /* fs-2 — non-English book: force Qwen + forbid the English Kokoro
           fallback so an undesigned voice fails loudly rather than reading
           the wrong language. */
        const bookLanguage = bookStateLanguage(state);
        const nonEnglishBook = isNonEnglish(bookLanguage);
        if (nonEnglishBook) {
          for (const c of cast.characters) c.ttsEngine = 'qwen';
          /* fs-32c — mirror generation: a reused designed Qwen voice whose
             baked manifest language ≠ this book's is cleared so the
             forbidKokoroFallback gate blocks it (undesigned) rather than
             re-recording the line in the wrong language. */
          await clearMismatchedDesignedVoices(
            cast.characters,
            sidecarLanguageName(bookLanguage),
            bookLanguage,
          );
        }
        const requiredEngines = new Set(cast.characters.map((c) => resolveCharacterEngine(c, engine)));
        const qwenInUse = requiredEngines.has('qwen');
        const qwenState = getLastKnownQwenInstallState();
        const qwenUnavailable = qwenInUse && qwenState !== 'ready' && qwenState !== 'loaded';

        /* Sentences come from the same analysis source generation uses; rebuild
           from edits first so a re-record matches the last rendered text. */
        const editsPath = manuscriptEditsJsonPath(bookDir);
        const editsSnapshot = await readJson<{ sentences?: unknown[] }>(editsPath);
        if (Array.isArray(editsSnapshot?.sentences) && editsSnapshot.sentences.length > 0) {
          await rebuildCacheFromEdits(state.manuscriptId, editsPath).catch(() => {});
        }
        const analysis = await loadAnalysisCache(state.manuscriptId);
        const sentences = analysis.chapters?.[chapterId] ?? [];
        if (!sentences.length) {
          return fail('No analysed sentences cached for this chapter — re-run analysis first.');
        }

        replacements = await buildSynthReplacements({
          segments: segFile.segments,
          targetIndices,
          chapterSampleRate: sampleRate,
          synth: async (seg) => {
            const ids = new Set(seg.sentenceIds);
            const subset = sentences.filter((s) => ids.has(s.id));
            send({ type: 'progress', chapterId, characterId, progress: 0.5 });
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
            return { pcm: r.pcm, sampleRate: r.sampleRate };
          },
        });
      }

      if (controller.signal.aborted) {
        return fail('Splice was displaced by another job for this chapter.');
      }

      const spliced = spliceChapterSegments({
        decodedPcm,
        sampleRate,
        segments: segFile.segments,
        replacements,
      });

      /* fs-32a — QA expects the POST-splice duration, not the prior whole-chapter
         length. A legitimate re-record changes the replaced region's length, so
         comparing the new chapter against the OLD total false-flagged "suspect".
         Compute the expected new duration analytically: prior total minus each
         replaced span's original length plus its new (replacement PCM) length.
         The QA duration band then reads the chapter against its own predicted
         length (ratio ≈ 1.0 for a normal re-record) while still catching a gross
         truncation / runaway inside the re-recorded region. */
      let expectedSec = segFile.durationSec;
      for (const r of replacements) {
        const originalSpanSec =
          segFile.segments[r.endSegmentIndex].endSec - segFile.segments[r.startSegmentIndex].startSec;
        const newSpanSec = pcmDurationSec(r.pcm.length, sampleRate);
        expectedSec += newSpanSec - originalSpanSec;
      }

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
        defaultEngine,
        modelKey: finalizeModelKey,
        audioFormat: bookStateAudioFormat(state as BookStateJson),
        expectedSec,
      });

      send({
        type: 'splice_complete',
        chapterId,
        characterId,
        mode,
        durationSec: result.durationSec,
        segmentCount: result.segmentCount,
        hasPreviousAudio: true,
      });
      res.end();
    } catch (err) {
      fail(`Splice failed: ${(err as Error).message}`);
    } finally {
      releaseSlot();
    }
  },
);

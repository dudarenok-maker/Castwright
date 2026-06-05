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

      /* Scan every sentence-backed segment (skip the title beat). */
      const flagged: Array<{
        segmentIndex: number;
        characterId: string;
        sentenceIds: number[];
        reasons: string[];
      }> = [];
      segFile.segments.forEach((seg, i) => {
        if (!isRerecordableSegment(seg)) return;
        const start = secToByteOffset(seg.startSec, sampleRate, decodedPcm.length);
        const end = secToByteOffset(seg.endSec, sampleRate, decodedPcm.length);
        const verdict = evaluateSegmentPcm(decodedPcm.subarray(start, end), sampleRate, segText(seg));
        if (verdict.status === 'suspect') {
          flagged.push({
            segmentIndex: i,
            characterId: seg.characterId,
            sentenceIds: seg.sentenceIds.slice(),
            reasons: verdict.reasons,
          });
        }
      });

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
      if (!modelKey) return fail('modelKey must be a supported TTS model id to repair.');
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

      const targetIndices = flagged.map((f) => f.segmentIndex);
      const stillSuspect: number[] = [];
      const repaired: number[] = [];

      const replacements: SegmentReplacement[] = await buildSynthReplacements({
        segments: segFile.segments,
        targetIndices,
        chapterSampleRate: sampleRate,
        synth: async (seg) => {
          const segIndex = segFile.segments.indexOf(seg);
          const ids = new Set(seg.sentenceIds);
          const subset = sentences.filter((s) => ids.has(s.id));
          const text = segText(seg);
          let best: { pcm: Buffer; sampleRate: number } | null = null;
          let bestVerdict: SegmentQaVerdict | null = null;
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
            if (!best || !bestVerdict || isBetter(v, bestVerdict)) {
              best = { pcm: r.pcm, sampleRate: r.sampleRate };
              bestVerdict = v;
            }
            if (bestVerdict.status === 'ok') break;
          }
          if (!best) throw new Error('Re-record produced no audio.');
          if (bestVerdict?.status === 'suspect') stillSuspect.push(segIndex);
          else repaired.push(segIndex);
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

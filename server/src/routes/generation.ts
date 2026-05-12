/* POST /api/books/:bookId/generation — SSE stream of GenerationTick events.

   Replaces the mocked streamGeneration. Loads the confirmed cast + cached
   analysis sentences, walks each target chapter, calls synthesiseChapter,
   then atomically writes:
     audio/<slug>.wav             — concatenated 16-bit PCM in a WAVE container
     audio/<slug>.segments.json   — per-group timing metadata
   and updates the chapter's `duration` in .audiobook/state.json.

   Resumability: a chapter is "complete" iff its .wav file exists. Partial
   chapters never land on disk because we hold the PCM in memory until the
   whole chapter is done.

   Pause semantics: when the client closes the SSE (Pause button), we DO NOT
   abort the chapter in flight — it finishes its remaining groups and persists
   its WAV. The outer loop checks `pauseRequested` between chapters and
   bails. Resume = new POST, picks up from disk state (the just-finished
   chapter has a WAV now, so the loop starts on the next one). At connect
   time we replay `chapter_complete` ticks for every already-done chapter so
   a reconnecting client reconciles state in one round-trip. */

import { Router, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir, castJsonPath, stateJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { engineForModelKey, isTtsModelKey, selectTtsProvider, type TtsModelKey } from '../tts/index.js';
import { pcmToWav } from '../tts/wav.js';
import {
  synthesiseChapter,
  type CastCharacter,
  type ChapterSegment,
} from '../tts/synthesise-chapter.js';

export const generationRouter = Router();

interface GenerationRequestBody {
  modelKey?: unknown;
  chapterIds?: unknown;
  force?: unknown;
}

interface ChapterSegmentsFile {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  durationSec: number;
  sampleRate: number;
  modelKey: TtsModelKey;
  synthesizedAt: string;
  segments: ChapterSegment[];
}

generationRouter.post('/:bookId/generation', async (req: Request, res: Response) => {
  const { bookId } = req.params;
  const body = (req.body ?? {}) as GenerationRequestBody;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (!isTtsModelKey(body.modelKey)) {
    send({ type: 'chapter_failed', errorReason: 'modelKey must be a supported TTS model id (e.g. coqui-xtts-v2, gemini-2.5-flash).' });
    return res.end();
  }
  const modelKey: TtsModelKey = body.modelKey;
  const engine = engineForModelKey(modelKey);
  const force = body.force === true;
  const requestedIds = Array.isArray(body.chapterIds)
    ? (body.chapterIds.filter(n => typeof n === 'number' && Number.isInteger(n)) as number[])
    : null;

  let provider;
  try {
    provider = selectTtsProvider(modelKey);
  } catch (e) {
    send({ type: 'chapter_failed', errorReason: (e as Error).message });
    return res.end();
  }

  const located = await findBookByBookId(bookId);
  if (!located) {
    send({ type: 'chapter_failed', errorReason: `No book found for id "${bookId}".` });
    return res.end();
  }
  const { bookDir, state } = located;

  /* Cast must be confirmed for synthesis to know which voice each character
     speaks in. The frontend should gate the generate button on this, but
     we double-check server-side so a stale URL doesn't kick off a bad run. */
  const cast = await readJson<{ characters: CastCharacter[] }>(castJsonPath(bookDir));
  if (!cast?.characters?.length) {
    send({ type: 'chapter_failed', errorReason: 'Cast not confirmed yet — open the cast view first.' });
    return res.end();
  }

  const analysis = await loadAnalysisCache(state.manuscriptId);
  if (!analysis.chapters || Object.keys(analysis.chapters).length === 0) {
    send({ type: 'chapter_failed', errorReason: 'No analysed sentences cached for this book. Re-run analysis first.' });
    return res.end();
  }

  const audioRoot = audioDir(bookDir);
  await mkdir(audioRoot, { recursive: true });

  /* Catch-up replay: emit a chapter_complete for every chapter already on
     disk so a reconnecting client (post-pause, page refresh, etc.) snaps to
     the latest state without needing a separate GET. Cheap — one tick per
     done chapter. We do this BEFORE deciding the queue so the client sees
     state even when nothing new is queued. */
  for (const ch of state.chapters) {
    if (existsSync(join(audioRoot, `${ch.slug}.wav`))) {
      const cachedSentences = analysis.chapters[ch.id] ?? [];
      send({
        type: 'chapter_complete',
        chapterId: ch.id,
        characterId: null,
        progress: 1,
        currentLine: cachedSentences.length,
        totalLines: cachedSentences.length,
      });
    }
  }

  /* Decide which chapters to (re)generate. Default: every chapter that does
     not already have an audio file on disk. `force` overrides existence. */
  const targetChapters = state.chapters.filter(c => {
    if (requestedIds && !requestedIds.includes(c.id)) return false;
    if (force) return true;
    const wavPath = join(audioRoot, `${c.slug}.wav`);
    return !existsSync(wavPath);
  });

  if (targetChapters.length === 0) {
    send({ type: 'idle' });
    return res.end();
  }

  /* Pause = client closes the SSE. We let the chapter in flight finish (its
     PCM is in memory; killing it would waste the synth work already done).
     The flag is checked at the top of the chapter loop, so the queue stops
     cleanly between chapters. */
  let pauseRequested = false;
  req.on('close', () => { pauseRequested = true; });

  for (const chapter of targetChapters) {
    if (pauseRequested) break;

    const sentences = analysis.chapters[chapter.id] ?? [];
    if (sentences.length === 0) {
      send({
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason: 'No sentences available for this chapter — analysis cache is incomplete.',
      });
      continue;
    }

    const totalLines = sentences.length;
    send({
      type: 'progress',
      chapterId: chapter.id,
      characterId: null,
      progress: 0.01,
      currentLine: 0,
      totalLines,
    });

    try {
      const result = await synthesiseChapter({
        sentences,
        cast: cast.characters,
        provider,
        modelKey,
        engine,
        onGroupComplete: ({ group, totalGroups }) => {
          const progress = Math.min(0.99, (group.index + 1) / totalGroups);
          const lastSentenceId = group.sentenceIds[group.sentenceIds.length - 1];
          /* currentLine is positional; clamp to sentences.length so the UI's
             "line N of M" reads naturally even when sentence ids aren't 1..N. */
          const positional = sentences.findIndex(s => s.id === lastSentenceId);
          send({
            type: 'progress',
            chapterId: chapter.id,
            characterId: group.characterId,
            progress,
            currentLine: positional >= 0 ? positional + 1 : group.index + 1,
            totalLines,
          });
        },
      });

      const wavBuffer = pcmToWav(result.pcm, result.sampleRate);
      const wavPath = join(audioRoot, `${chapter.slug}.wav`);
      const segPath = join(audioRoot, `${chapter.slug}.segments.json`);

      /* Atomic write: temp-then-rename so a crash mid-write doesn't leave a
         half-WAV that scan.ts would mistake for a completed chapter. */
      const tmpWav = `${wavPath}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpWav, wavBuffer);
      const segmentsFile: ChapterSegmentsFile = {
        bookId,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        modelKey,
        synthesizedAt: new Date().toISOString(),
        segments: result.segments,
      };
      await writeJsonAtomic(segPath, segmentsFile);
      await rename(tmpWav, wavPath);

      /* Update state.json with the freshly-measured duration so the library
         + future playback slice can render it without re-reading the WAV. */
      const statePath = stateJsonPath(bookDir);
      const prev = await readJson<BookStateJson>(statePath);
      if (prev) {
        const formatted = formatDuration(result.durationSec);
        const next: BookStateJson = {
          ...prev,
          chapters: prev.chapters.map(c =>
            c.id === chapter.id ? { ...c, duration: formatted } : c,
          ),
          updatedAt: new Date().toISOString(),
        };
        await writeJsonAtomic(statePath, next);
      }

      send({
        type: 'chapter_complete',
        chapterId: chapter.id,
        characterId: null,
        progress: 1,
        currentLine: totalLines,
        totalLines,
      });
    } catch (e) {
      const { errorReason, fatal } = describeSynthesisError(e);
      console.error(`[generation] chapter ${chapter.id} (${chapter.slug}) failed:`, e);
      send({
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason,
      });
      if (fatal) break;
    }
  }

  send({ type: 'idle' });
  res.end();
});

/** Format seconds as MM:SS or HH:MM:SS — matches the existing `duration`
    string convention in state.json (`'00:00'` placeholder from analysis). */
function formatDuration(totalSec: number): string {
  const total = Math.max(0, Math.round(totalSec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** Pull a short, user-friendly reason out of a synth error and flag
    unrecoverable classes as fatal so we stop the run instead of burning
    through the remaining chapters with the same failure. */
function describeSynthesisError(err: unknown): { errorReason: string; fatal: boolean } {
  const raw = (err as Error)?.message ?? String(err);
  const status = (err as { status?: number })?.status;
  const isSidecarDown = /sidecar not reachable|ECONNREFUSED|fetch failed/i.test(raw);
  const isQuota = status === 429 || /429|quota|rate/i.test(raw);
  const isAuth = status === 401 || status === 403 || /invalid[_ ]?key|API key/i.test(raw);
  if (isSidecarDown) {
    return { errorReason: 'Local TTS sidecar not running — start it and resume.', fatal: true };
  }
  if (isQuota) {
    return { errorReason: 'Gemini TTS rate-limited — stopped run; resume later or switch to a local engine.', fatal: true };
  }
  if (isAuth) {
    return { errorReason: 'Gemini TTS authentication failed — check GEMINI_API_KEY.', fatal: true };
  }
  const trimmed = raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
  return { errorReason: trimmed, fatal: false };
}


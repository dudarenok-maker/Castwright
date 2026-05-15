/* POST /api/books/:bookId/generation — SSE stream of GenerationTick events.

   Replaces the mocked streamGeneration. Loads the confirmed cast + cached
   analysis sentences, walks each target chapter, calls synthesiseChapter,
   then atomically writes:
     audio/<slug>.mp3             — concatenated PCM encoded as MP3 (LAME VBR V2)
     audio/<slug>.segments.json   — per-group timing metadata
   and updates the chapter's `duration` in .audiobook/state.json.

   Resumability: a chapter is "complete" iff an audio file exists for it on
   disk — .mp3 (new generations) or .wav (legacy chapters from before the
   MP3 switch). Partial chapters never land on disk because we hold the PCM
   in memory until the whole chapter is done.

   Pause semantics: when the client closes the SSE (Pause button), we DO NOT
   abort the chapter in flight — it finishes its remaining groups and persists
   its WAV. The outer loop checks `pauseRequested` between chapters and
   bails. Resume = new POST, picks up from disk state (the just-finished
   chapter has a WAV now, so the loop starts on the next one). At connect
   time we replay `chapter_complete` ticks for every already-done chapter so
   a reconnecting client reconciles state in one round-trip. */

import { Router, type Request, type Response } from 'express';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir, castJsonPath, stateJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { findBookByBookId, type BookStateJson } from '../workspace/scan.js';
import { chapterAudioExists } from '../workspace/chapter-audio-file.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { engineForModelKey, isTtsModelKey, selectTtsProvider, type TtsModelKey } from '../tts/index.js';
import { encodePcmToMp3 } from '../tts/mp3.js';
import {
  synthesiseChapter,
  type CastCharacter,
  type ChapterSegment,
} from '../tts/synthesise-chapter.js';
import { describeSynthesisError, newCascadeState, recordNonFatal } from './generation-error.js';

export const generationRouter = Router();

/* Per-bookId mutex. A second POST for the same book aborts the first — the
   in-flight handler's `synthesiseChapter` loop checks `signal.aborted` between
   groups and the sidecar fetch receives the same signal, so a stale handler
   stops within seconds rather than running to the end of the chapter.

   Without this, the client's regenerate flow can stack handlers: Pause aborts
   the client SSE but the server keeps processing; a subsequent Resume opens
   a fresh handler against the same book, the sidecar serialises both, and the
   user sits through duplicate work. With the mutex, "newest request wins" —
   the prior handler shuts down cleanly (emits a final `idle` from the
   AbortError catch) and the new one runs alone. */
const inFlightByBook: Map<string, AbortController> = new Map();

interface GenerationRequestBody {
  modelKey?: unknown;
  chapterIds?: unknown;
  force?: unknown;
}

/* Snapshot of a character's voice-relevant attributes captured at the
   moment a chapter is synthesised. The revisions route diffs this against
   the live cast.json to surface drift events ("voice swapped after this
   chapter rendered", "tone.warmth drifted 30 points", etc.). Kept narrow
   on purpose — only fields the drift detector reads. */
interface CharacterSnapshot {
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  voiceId?: string;
  voiceEngine?: string;
  /** Attribute list captured at synthesis time. The drift detector
      compares this against the current cast's attributes — a non-empty
      symmetric difference fires a drift event because attributes drive
      prebuilt-voice selection in tts-voice-mapping.ts. Sorted so the
      snapshot is stable across runs even when the analyzer emits the
      same set in different orders. */
  attributes?: string[];
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
  /** Snapshot of cast character attributes at synthesis time, keyed by
      characterId. Used by /api/books/:bookId/revisions to detect drift
      between the current cast and what was actually rendered. Optional
      because pre-existing segments files written before this field landed
      have no snapshots; the revisions route treats them as "no signal". */
  characterSnapshots?: Record<string, CharacterSnapshot>;
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
     state even when nothing new is queued.

     Excluded chapters are skipped — even if stale audio is still on disk
     from before they were excluded, we don't want to tell the frontend
     the chapter is "complete" when the user opted out of narrating it. */
  for (const ch of state.chapters) {
    if (ch.excluded) continue;
    if (chapterAudioExists(audioRoot, ch.slug)) {
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
     not already have an audio file on disk. `force` overrides existence.
     Excluded chapters (front/back-matter the user opted out of narrating)
     are always skipped — even an explicit requestedIds=[...] that lists an
     excluded chapter is filtered out, since generating audio for an
     excluded chapter would silently undo the user's choice. */
  const targetChapters = state.chapters.filter(c => {
    if (c.excluded) return false;
    if (requestedIds && !requestedIds.includes(c.id)) return false;
    if (force) return true;
    return !chapterAudioExists(audioRoot, c.slug);
  });

  if (targetChapters.length === 0) {
    send({ type: 'idle' });
    return res.end();
  }

  /* Per-bookId mutex: if a previous handler is still running for this book,
     abort it. Its synthesiseChapter loop will see signal.aborted between
     groups (and the sidecar fetch will reject with AbortError mid-call),
     bail out via the AbortError catch below, and end its response. We then
     register our own controller for the next caller to displace if needed. */
  const previousController = inFlightByBook.get(bookId);
  if (previousController) previousController.abort();
  const controller = new AbortController();
  inFlightByBook.set(bookId, controller);

  /* Pause = client closes the SSE. We abort our own controller so the
     synth loop bails between groups instead of running the chapter to
     completion. (The pre-mutex behaviour was to let the in-flight chapter
     finish — but with the mutex we want a "newest request wins" semantics
     and the user gets faster feedback on Pause.) */
  req.on('close', () => controller.abort());

  /* Cascade detector — if the same non-fatal reason fails two chapters in
     a row, the failure is deterministic (e.g. sidecar mis-routing every
     character to an invalid speaker_id) and the rest of the queue will hit
     the same wall. Escalate to fatal on the second hit so the user gets one
     clean banner instead of a long stream of identical chapter_failed
     ticks. See screenshot 2026-05-13 181647 for the cascade we're killing. */
  const cascade = newCascadeState();

  for (const chapter of targetChapters) {
    if (controller.signal.aborted) break;

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
        signal: controller.signal,
        /* Tick AT THE START of each group so the client's 30s "Worker has
           gone quiet" stall detector resets even when a single group is a
           multi-minute synth call (long narrator block on CPU XTTS).
           Without this, group-complete was the only tick and the SSE went
           silent for the entire duration of each call. */
        onGroupStart: ({ group, totalGroups }) => {
          const firstSentenceId = group.sentenceIds[0];
          const positional = sentences.findIndex(s => s.id === firstSentenceId);
          /* progress reports the lower bound for this group — group.index/totalGroups
             rather than (index+1)/total — so the bar doesn't visibly snap forward
             at start and then sit still while the call runs. */
          const progress = Math.min(0.99, group.index / Math.max(1, totalGroups));
          send({
            type: 'progress',
            chapterId: chapter.id,
            characterId: group.characterId,
            progress,
            currentLine: positional >= 0 ? positional + 1 : group.index + 1,
            totalLines,
          });
        },
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

      /* All per-group synthesis is done; the next stretch is disk-write
         work (encode MP3 → temp file → segments JSON → atomic rename →
         state.json update). Tell the client so it stops looking like a
         frozen 99 %. */
      send({
        type: 'chapter_assembling',
        chapterId: chapter.id,
        characterId: null,
        progress: 0.995,
        currentLine: totalLines,
        totalLines,
        totalGroups: result.segments.length,
        durationSec: result.durationSec,
      });

      const mp3Buffer = await encodePcmToMp3(result.pcm, result.sampleRate, { quality: 2 });
      const mp3Path = join(audioRoot, `${chapter.slug}.mp3`);
      const segPath = join(audioRoot, `${chapter.slug}.segments.json`);

      /* Atomic write: temp-then-rename so a crash mid-write doesn't leave a
         half-MP3 that scan.ts would mistake for a completed chapter. */
      const tmpMp3 = `${mp3Path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmpMp3, mp3Buffer);
      /* Snapshot the cast character attributes for every character that
         actually spoke in this chapter — narrows the snapshot to the
         characters the drift detector cares about and avoids bloating the
         segments file with the full cast on tiny chapters. */
      const speakingIds = new Set(result.segments.map(s => s.characterId));
      const characterSnapshots: Record<string, CharacterSnapshot> = {};
      for (const c of cast.characters) {
        if (!speakingIds.has(c.id)) continue;
        characterSnapshots[c.id] = {
          tone: c.tone,
          gender: c.gender,
          ageRange: c.ageRange,
          voiceId: c.voiceId,
          voiceEngine: engine,
          /* Sorted for stable comparison — the analyzer's attribute order
             isn't deterministic across runs, so without the sort an
             order-only change would look like drift to the detector. */
          attributes: Array.isArray(c.attributes) && c.attributes.length
            ? [...c.attributes].sort((a, b) => a.localeCompare(b))
            : undefined,
        };
      }

      const segmentsFile: ChapterSegmentsFile = {
        bookId,
        chapterId: chapter.id,
        chapterTitle: chapter.title,
        durationSec: result.durationSec,
        sampleRate: result.sampleRate,
        modelKey,
        synthesizedAt: new Date().toISOString(),
        segments: result.segments,
        characterSnapshots,
      };
      await writeJsonAtomic(segPath, segmentsFile);
      await rename(tmpMp3, mp3Path);

      /* Update state.json with the freshly-measured duration so the library
         + future playback slice can render it without re-reading the audio. */
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
      /* AbortError = our own controller fired (mutex displacement or client
         close). Don't report it as a chapter failure — silently break the
         loop; the outer `idle` + cleanup below handles the rest. */
      if ((e as { name?: string })?.name === 'AbortError') break;
      const initial = describeSynthesisError(e);
      let { errorReason, fatal } = initial;
      console.error(`[generation] chapter ${chapter.id} (${chapter.slug}) failed:`, e);
      if (!fatal) {
        const cascadeResult = recordNonFatal(cascade, errorReason);
        if (cascadeResult.fatal) {
          fatal = true;
          errorReason = `${errorReason} (Stopping run — same failure repeated across chapters; fix the upstream cause before retrying.)`;
        }
      }
      send({
        type: 'chapter_failed',
        chapterId: chapter.id,
        errorReason,
      });
      if (fatal) break;
    }
  }

  /* Only deregister if we're still the current controller — a newer request
     may have already displaced us, and removing its entry would defeat the
     mutex for a third caller. */
  if (inFlightByBook.get(bookId) === controller) {
    inFlightByBook.delete(bookId);
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


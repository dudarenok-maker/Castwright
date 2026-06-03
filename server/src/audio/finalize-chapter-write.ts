/* Shared encode + persist tail for a rendered chapter. Given final PCM +
   segments, it: EBU-R128-normalises + encodes, evaluates advisory QA, builds
   the per-character drift snapshots, preserves the prior take as `.previous.*`
   (the A/B + rollback substrate), atomically writes `<slug>.<ext>` +
   `<slug>.segments.json`, emits the peaks sibling, and stamps the chapter's
   duration / model / QA into state.json.

   Authored for the fs-26 splice path so a re-mix/re-record persists byte-
   identically to a full regen (same loudnorm target, same segments-file shape,
   same `.previous.*` preservation, same state.json fields). generation.ts still
   inlines the equivalent tail (woven into its job/SSE bookkeeping); converging
   it onto this helper is a deliberate follow-up — see fs-26 plan doc. */

import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir, stateJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import { type BookStateJson } from '../workspace/scan.js';
import { preserveExistingAsPrevious } from '../workspace/preserve-previous-audio.js';
import { formatDuration } from './format-duration.js';
import {
  audioExtForFormat,
  encodePcmToAudio,
  writeChapterLufsFile,
  writeChapterPeaksFile,
  type EncodePcmAudioFormat,
} from '../tts/mp3.js';
import { DEFAULT_LOUDNORM_OPTIONS, type LoudnormSidecarJson } from '../tts/loudnorm.js';
import { evaluateChapterQa, type ChapterQaVerdict } from '../tts/audio-qa.js';
import type { ChapterSegment, CastCharacter } from '../tts/synthesise-chapter.js';
import type { TtsEngine, TtsModelKey } from '../tts/index.js';
import { buildCharacterSnapshots } from './character-snapshots.js';
import type { CharacterSnapshot } from './segments-io.js';

/** Strict on-disk shape of `<slug>.segments.json` (the write view; the loose
    read view lives in segments-io.ts). Mirrors generation.ts's local copy. */
export interface ChapterSegmentsFile {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  durationSec: number;
  sampleRate: number;
  modelKey: TtsModelKey;
  synthesizedAt: string;
  segments: ChapterSegment[];
  characterSnapshots?: Record<string, CharacterSnapshot>;
  qa?: ChapterQaVerdict;
}

export interface FinalizeChapterAudioInput {
  bookId: string;
  bookDir: string;
  chapter: { id: number; slug: string; title: string };
  /** Final concatenated 16-bit LE mono PCM for the whole chapter. */
  pcm: Buffer;
  sampleRate: number;
  durationSec: number;
  segments: ChapterSegment[];
  cast: CastCharacter[];
  /** Run default engine; per-character engine still wins in the snapshot. */
  defaultEngine: TtsEngine;
  modelKey: TtsModelKey;
  audioFormat: EncodePcmAudioFormat;
  /** Expected seconds for the QA duration check. For a splice pass the prior
      chapter duration; absent → uses the new duration (QA duration check
      becomes a no-op). */
  expectedSec?: number;
}

export interface FinalizeChapterAudioResult {
  durationSec: number;
  audioQa: ChapterQaVerdict;
  segmentCount: number;
}

export async function finalizeChapterAudioWrite(
  input: FinalizeChapterAudioInput,
): Promise<FinalizeChapterAudioResult> {
  const { bookId, bookDir, chapter, pcm, sampleRate, durationSec, segments, cast, defaultEngine, modelKey, audioFormat } =
    input;

  const audioRoot = audioDir(bookDir);
  const audioExt = audioExtForFormat(audioFormat);
  const audioPath = join(audioRoot, `${chapter.slug}.${audioExt}`);
  const segPath = join(audioRoot, `${chapter.slug}.segments.json`);
  const peaksPath = join(audioRoot, `${chapter.slug}.peaks.json`);
  const lufsPath = join(audioRoot, `${chapter.slug}.lufs.json`);

  /* EBU R128 loudness normalisation (plan 71). Default ON; opt out with
     AUDIO_LOUDNORM_ENABLED=false. Two-pass measure-then-apply runs inside
     encodePcmToAudio; the callback persists the sidecar. */
  const loudnorm = process.env.AUDIO_LOUDNORM_ENABLED === 'false' ? undefined : DEFAULT_LOUDNORM_OPTIONS;
  let loudnormStats: LoudnormSidecarJson | null = null;
  const audioBuffer = await encodePcmToAudio(pcm, sampleRate, {
    format: audioFormat,
    quality: 2,
    loudnorm,
    onLoudnessMeasured: async (stats) => {
      loudnormStats = stats;
      try {
        await writeChapterLufsFile(stats, lufsPath);
      } catch (err) {
        console.warn(
          `[splice] failed to write loudness sidecar for ${chapter.slug}: ${(err as Error).message}`,
        );
      }
    },
  });

  /* srv-27 — advisory post-synthesis QA. `loudnormStats` is null when loudnorm
     is disabled (only the duration check runs then). */
  const measured = loudnormStats as LoudnormSidecarJson | null;
  const audioQa: ChapterQaVerdict = evaluateChapterQa({
    durationSec,
    expectedSec: input.expectedSec ?? durationSec,
    lufs: measured ? measured.i : null,
    truePeakDb: measured ? measured.tp : null,
  });

  const speakingIds = new Set(segments.map((s) => s.characterId));
  const fallbackByChar = new Map<string, string>();
  for (const s of segments) {
    if (s.renderedFallbackEngine) fallbackByChar.set(s.characterId, s.renderedFallbackEngine);
  }
  const characterSnapshots = buildCharacterSnapshots(cast, speakingIds, defaultEngine, fallbackByChar);

  const segmentsFile: ChapterSegmentsFile = {
    bookId,
    chapterId: chapter.id,
    chapterTitle: chapter.title,
    durationSec,
    sampleRate,
    modelKey,
    synthesizedAt: new Date().toISOString(),
    segments,
    characterSnapshots,
    qa: audioQa,
  };

  const tmpAudio = `${audioPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpAudio, audioBuffer);
  /* Rollback preservation: rename the live `<slug>.<ext>` + `.segments.json`
     to `.previous.*` BEFORE the new render lands. The revision-diff player
     auditions the preserved pair (A) vs this render (B). */
  await preserveExistingAsPrevious(audioRoot, chapter.slug);
  await writeJsonAtomic(segPath, segmentsFile);
  await rename(tmpAudio, audioPath);
  try {
    await writeChapterPeaksFile(pcm, sampleRate, peaksPath);
  } catch (err) {
    console.warn(`[splice] failed to write peaks for ${chapter.slug}: ${(err as Error).message}`);
  }

  /* Stamp duration / model / QA into state.json (read-modify-write, keyed by
     chapter id so concurrent sibling writes can't clobber each other). */
  const statePath = stateJsonPath(bookDir);
  const prev = await readJson<BookStateJson>(statePath);
  if (prev) {
    const formatted = formatDuration(durationSec);
    const next: BookStateJson = {
      ...prev,
      chapters: prev.chapters.map((c) =>
        c.id === chapter.id
          ? {
              ...c,
              duration: formatted,
              audioModelKey: modelKey,
              audioRenderedAt: segmentsFile.synthesizedAt,
              audioQa,
              generationState: undefined,
              generationError: undefined,
              generationErrorCode: undefined,
              generationRemediation: undefined,
            }
          : c,
      ),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(statePath, stampStateSchema(next));
  }

  return { durationSec, audioQa, segmentCount: segments.length };
}

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
import { resolveLoudnormOptions, type LoudnormSidecarJson } from '../tts/loudnorm.js';
import { configValue } from '../config/resolver.js';
import { evaluateChapterQa, type ChapterQaVerdict } from '../tts/audio-qa.js';
import type { ChapterSegment, CastCharacter } from '../tts/synthesise-chapter.js';
import type { TtsEngine, TtsModelKey } from '../tts/index.js';
import { buildCharacterSnapshots } from './character-snapshots.js';
import {
  engineBreakdownFromSnapshots,
  effectiveAudioModelKey,
  type AudioEngineBreakdown,
} from './engine-breakdown.js';
import type { CharacterSnapshot } from './segments-io.js';
import {
  writeEmbeddings,
  type EmbeddingRow,
  EMBEDDINGS_VERSION,
} from './render-integrity/embeddings-io.js';

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
  /** Invoked once, immediately AFTER the encode (2-pass loudnorm) returns and
      BEFORE QA / snapshots / write. The generation route passes its
      `bumpProgress` here so the per-chapter no-progress watchdog sees the long
      encode step land. No-op for callers that don't need it. */
  onEncoded?: () => void | Promise<void>;
  /** srv-36 render-integrity: per-group ECAPA embedding rows collected by
      synthesiseChapter's spk pass. When present, written as a separate atomic
      `<slug>.embeddings.json` sibling after the segments write. Optional — absent
      when `qa.speaker.enabled` is off or no stochastic-engine groups qualified. */
  embeddings?: EmbeddingRow[];
}

export interface FinalizeChapterAudioResult {
  durationSec: number;
  audioQa: ChapterQaVerdict;
  segmentCount: number;
  /** Chapter-wide drift stamp: the engine the audio ACTUALLY rendered in
      (per-character routing aware), not necessarily the request `modelKey`.
      The generation route puts this on the `chapter_complete` SSE tick. */
  audioModelKey: TtsModelKey;
  /** Distinct speaking characters per engine they rendered in. Drives the
      mixed-engine "Kokoro (1), Qwen (6)" caption. */
  audioEngines: AudioEngineBreakdown;
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
  const loudnorm = configValue<boolean>('audio.loudnorm.enabled') ? resolveLoudnormOptions() : undefined;
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

  /* Encode (2-pass loudnorm) done — the long step. Let the caller record
     forward progress before QA/snapshots/write (generation's watchdog bump). */
  if (input.onEncoded) await input.onEncoded();

  /* srv-27 — advisory post-synthesis QA. `loudnormStats` is null when loudnorm
     is disabled (only the duration check runs then). */
  const measured = loudnormStats as LoudnormSidecarJson | null;
  const baseQa: ChapterQaVerdict = evaluateChapterQa({
    durationSec,
    expectedSec: input.expectedSec ?? durationSec,
    lufs: measured ? measured.i : null,
    truePeakDb: measured ? measured.tp : null,
  });
  /* Roll the pre-assembly per-sentence gate (segment-qa.ts, plan 179) into the
     chapter-level verdict so the existing "Suspect" badge lights up when a
     sentence was kept despite still failing QA after its re-records — the
     whole-chapter signals above can't see a single bad sentence in a long
     chapter. Shared here (rather than inline in generation) so the splice path
     gets the same roll-up; splice segments never carry `suspect`, so it's a
     no-op there. */
  const suspectSegments = segments.filter((s) => s.suspect);
  const audioQa: ChapterQaVerdict =
    suspectSegments.length > 0
      ? {
          ...baseQa,
          status: 'suspect',
          reasons: [
            ...baseQa.reasons,
            `${suspectSegments.length} sentence(s) still flagged after re-recording (e.g. ${
              suspectSegments[0].qa?.reasons[0] ?? 'audio QA'
            }).`,
          ],
        }
      : baseQa;

  const speakingIds = new Set(segments.map((s) => s.characterId));
  const fallbackByChar = new Map<string, string>();
  for (const s of segments) {
    if (s.renderedFallbackEngine) fallbackByChar.set(s.characterId, s.renderedFallbackEngine);
  }
  const characterSnapshots = buildCharacterSnapshots(cast, speakingIds, defaultEngine, fallbackByChar);

  /* Drift stamp from the ACTUAL render, not the request default (false-drift
     fix, 2026-06-07). The breakdown counts the speaking characters per engine
     they rendered in; the stamp collapses to the single engine's canonical key
     when uniform (so a narrator-on-Qwen chapter regenerated under a Kokoro
     default stamps Qwen, clearing the false badge), else keeps the request key
     and lets the breakdown carry the mixed-engine detail. */
  const audioEngines = engineBreakdownFromSnapshots(characterSnapshots);
  const effectiveModelKey = effectiveAudioModelKey(audioEngines, modelKey);

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
  if (input.embeddings) {
    const embPath = join(audioRoot, `${chapter.slug}.embeddings.json`);
    await writeEmbeddings(embPath, input.embeddings, EMBEDDINGS_VERSION);
  }
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
              audioModelKey: effectiveModelKey,
              audioEngines,
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

  return {
    durationSec,
    audioQa,
    segmentCount: segments.length,
    audioModelKey: effectiveModelKey,
    audioEngines,
  };
}

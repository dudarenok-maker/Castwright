/* Shared encode + persist tail for a rendered chapter. Given final PCM +
   segments, it: EBU-R128-normalises + encodes, evaluates advisory QA, builds
   the per-character drift snapshots, preserves the prior take as `.previous.*`
   (the A/B + rollback substrate), atomically writes `<slug>.<ext>` +
   `<slug>.segments.json`, emits the peaks sibling, and stamps the chapter's
   duration / model / QA into state.json.

   Authored for the fs-26 splice path so a re-mix/re-record persists byte-
   identically to a full regen (same loudnorm target, same segments-file shape,
   same `.previous.*` preservation, same state.json fields). srv-29 converged
   `routes/generation.ts` onto this same helper (see its call site there) —
   it no longer inlines its own tail. */

import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audioDir, stateJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { type BookStateJson } from '../workspace/scan.js';
import { preserveExistingAsPrevious } from '../workspace/preserve-previous-audio.js';
import { formatDuration } from './format-duration.js';
import { measureLoudnessFile, type MeasuredLoudness } from './measure-loudness.js';
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
    read view lives in segments-io.ts). */
export interface ChapterSegmentsFile {
  bookId: string;
  chapterId: number;
  chapterTitle: string;
  durationSec: number;
  sampleRate: number;
  modelKey: TtsModelKey;
  synthesizedAt: string;
  /** #2128 — the `seq` of the `cast-id-history.json` state THIS render
      resolved against. Written ONLY by the full-render path
      (`generation.ts`); `chapter-qa-repair.ts` and `chapter-splice.ts` carry
      the prior file's value forward verbatim, because they rewrite the whole
      file while leaving most segments byte-identical, and refreshing this
      would launder a stale row into looking current.

      `0` is a VALID value, not an absent one. Absent means the render predates
      this stamp, which `isAudioCurrent` reads as 'unknown' — and 'unknown'
      lists. Deliberately NOT `synthesizedAt`, which the two partial writers
      DO refresh and which cannot speak to the `'normalised-id'` tier at all
      (that tier has no history entry; its hazard is a render predating the
      resolver, which this field's mere presence proves). */
  castHistorySeq?: number;
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
  /** #2128 — see `ChapterSegmentsFile.castHistorySeq`. Supplied by the
      full-render path from the history it actually built its resolver from;
      carried forward verbatim by the two partial writers. */
  castHistorySeq?: number;
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
     encodePcmToAudio; the callback just captures loudnorm's self-reported
     stats. The sidecar itself is written once, below, after the real
     ebur128 re-measurement (plan 274 T1/T2) — no longer here. */
  const loudnorm = configValue<boolean>('audio.loudnorm.enabled') ? resolveLoudnormOptions() : undefined;
  let loudnormStats: LoudnormSidecarJson | null = null;
  const audioBuffer = await encodePcmToAudio(pcm, sampleRate, {
    format: audioFormat,
    quality: 2,
    loudnorm,
    onLoudnessMeasured: (stats) => {
      loudnormStats = stats;
    },
  });

  /* Encode (2-pass loudnorm) done — the long step. Let the caller record
     forward progress before QA/snapshots/write (generation's watchdog bump). */
  if (input.onEncoded) await input.onEncoded();

  const tmpAudio = `${audioPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpAudio, audioBuffer);

  /* plan 274 T1 — hoist the single real ebur128 measurement to immediately
     after the encoded bytes hit disk (still at the temp path: the later
     rename is a same-directory move that preserves bytes exactly, so
     measuring `tmpAudio` and measuring `audioPath` are the same measurement
     of the same artifact). One result now feeds three consumers — the QA
     verdict below, the `.lufs.json` sidecar, and (T4) the `measurementSource`
     provenance flag — instead of the sidecar being written twice (once from
     loudnorm's self-report, once rewritten post-rename with the real
     measurement). Fails soft: `realLoudness` stays null on any failure and
     QA/sidecar fall back to loudnorm's self-reports (ops-36 finding 10; the
     three-shape fail-soft immediately below). */
  let realLoudness: MeasuredLoudness | null = null;
  if (loudnormStats) {
    try {
      realLoudness = await measureLoudnessFile(tmpAudio);
      if (!realLoudness) {
        console.warn(
          `[splice] ebur128 measurement unavailable for ${chapter.slug}; ` +
            `sidecar keeps loudnorm's self-reported figures`,
        );
      }
    } catch (err) {
      console.warn(
        `[splice] failed to measure loudness for ${chapter.slug}: ${(err as Error).message}`,
      );
    }
  }

  /* plan 274 T1 — single sidecar write (collapsed from the old two-write
     pattern: once from loudnorm's self-report during encode, once rewritten
     post-rename with the real measurement). `i`/`lra`/`tp` are rendered to
     users by the Listen view's loudness badge, and loudnorm's `output_tp` is
     the ceiling it was ASKED for, not what the audio reached (ops-36 finding
     10). Fails soft: on a failed measurement the sidecar keeps loudnorm's
     self-reported figures rather than breaking the render.

     plan 274 T4 — `measurementSource` records which of those two happened,
     so a reader (and the UI, once T6 lands) can tell a real measurement from
     a fallback rather than trusting every sidecar equally. */
  if (loudnormStats) {
    const sidecarPayload: LoudnormSidecarJson = realLoudness
      ? {
          ...(loudnormStats as LoudnormSidecarJson),
          i: realLoudness.i,
          lra: realLoudness.lra,
          tp: realLoudness.tp,
          measurementSource: 'ebur128',
        }
      : { ...(loudnormStats as LoudnormSidecarJson), measurementSource: 'loudnorm' };
    try {
      await writeChapterLufsFile(sidecarPayload, lufsPath);
    } catch (err) {
      console.warn(
        `[splice] failed to write loudness sidecar for ${chapter.slug}: ${(err as Error).message}`,
      );
    }
  }

  /* srv-27 — advisory post-synthesis QA. `loudnormStats` is null when loudnorm
     is disabled (only the duration check runs then).

     plan 274 T2 — three-shape fail-soft (audio-qa.ts header + plan
     §1.9/§2.2). `loudnormStats` has three reachable shapes, not one:
       - Shape A (`normalizationType` set): `i` is genuinely post-filter;
         `tp` is the REQUESTED ceiling, not a measurement (§1.3).
       - Shape B (`normalizationType` undefined, `twoPass: true`): the
         second-pass JSON was missing/unparseable/non-finite, so `i`/`tp`
         are the PRE-filter input measurement (§1.9) — judging QA on that
         risks a spurious `nearSilentLufs` trip on a chapter that actually
         normalised fine (§1.10).
       - Shape C (`twoPass: false`, unreachable in production — §1.5): `i`/`tp`
         are the nominal target, not a measurement.
     When `realLoudness` is present (the overwhelmingly common case) it feeds
     BOTH fields, unconditionally — shape doesn't matter. Absent that, only
     Shape A's `i` is trustworthy enough to judge on; `tp` NEVER falls back,
     because no shape of `loudnormStats.tp` is a real measurement.

     Not exhaustive: two more states exist beyond the three above.
       - A fourth shape: a two-pass encode whose second-pass JSON parses and
         passes `isSecondPassMeasurementUseable` (mp3.ts:436-455) but whose
         `normalization_type` is absent/unrecognised yields
         `normalizationType: undefined` while `i` is genuinely `output_i` —
         a real post-filter measurement. The `shapeA` discriminator below
         then misclassifies it as Shape B and sets `qaLufs = null`, silently
         skipping the near-silent check. Fails closed (never fabricates a
         measured figure), and today's ffmpeg always emits `linear`/`dynamic`,
         so this is a doc gap, not a live bug.
       - A fifth state: the first-pass measurement is unusable (dead-silent
         input) → `pendingSidecar` stays `null` → `onLoudnessMeasured` never
         fires → no sidecar and no QA figure at all. Handled correctly by the
         `if (loudnormStats)` guard above. */
  const measured = loudnormStats as LoudnormSidecarJson | null;
  const shapeA = measured?.normalizationType !== undefined;
  const qaLufs = realLoudness
    ? realLoudness.i
    : shapeA
      ? measured!.i
      : null;
  const qaTp = realLoudness ? realLoudness.tp : null;
  const baseQa: ChapterQaVerdict = evaluateChapterQa({
    durationSec,
    expectedSec: input.expectedSec ?? durationSec,
    lufs: qaLufs,
    truePeakDb: qaTp,
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
  /* #1972 — the voice ACTUALLY sent to the provider per character, read back
     from this render's own segments rather than re-derived from the cast
     record. See buildCharacterSnapshots' voiceNameByChar doc for why.
     M1 — prefer `baseVoiceName` (pre-emotion-variant) over the exact
     per-segment `voiceName`, so a character whose LAST speaking segment this
     run happens to be an emotion-tagged quote doesn't get the variant's
     `__<emotion>`-suffixed name stamped as its resolved voice. */
  const voiceNameByChar = new Map<string, string>();
  for (const s of segments) {
    if (s.renderedFallbackEngine) fallbackByChar.set(s.characterId, s.renderedFallbackEngine);
    const voiceName = s.baseVoiceName ?? s.voiceName;
    if (voiceName) voiceNameByChar.set(s.characterId, voiceName);
  }
  /* C1 (#1972 follow-up) — a character can be "speaking" this render (it has
     segments in `segments`) without this run having synthesised a single new
     sample for it: a gain-only remix reuses every existing segment's PCM
     untouched, so none of THIS run's segments carry `voiceName` at all —
     `voiceNameByChar` ends up SMALLER than `speakingIds`. Before this fix
     that silently dropped `resolvedVoiceName` for every character on a
     remix of a legacy (pre-#1972) chapter (and for any character a rerecord
     didn't target), corrupting revisions.ts's drift detector, the Voices
     "Designed vs Generated" split, and the srv-36 audition centroid — all of
     which read `resolvedVoiceName` back off disk. Nothing was actually
     re-synthesised for these characters, so the LAST render's own recorded
     voice is still the truthful answer: carry it forward from the prior
     segments file, read here BEFORE `preserveExistingAsPrevious` renames it
     to `.previous.segments.json` below. */
  if (voiceNameByChar.size < speakingIds.size) {
    const prior = await readJson<ChapterSegmentsFile>(segPath).catch(() => null);
    for (const id of speakingIds) {
      if (voiceNameByChar.has(id)) continue;
      const priorVoice = prior?.characterSnapshots?.[id]?.resolvedVoiceName;
      if (priorVoice) voiceNameByChar.set(id, priorVoice);
    }
  }
  const characterSnapshots = buildCharacterSnapshots(
    cast,
    speakingIds,
    defaultEngine,
    fallbackByChar,
    modelKey,
    voiceNameByChar,
  );

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
    ...(input.castHistorySeq === undefined ? {} : { castHistorySeq: input.castHistorySeq }),
    segments,
    characterSnapshots,
    qa: audioQa,
  };

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
    await writeStateJsonAtomic(statePath, { ...next, language: next.language ?? null });
  }

  return {
    durationSec,
    audioQa,
    segmentCount: segments.length,
    audioModelKey: effectiveModelKey,
    audioEngines,
  };
}

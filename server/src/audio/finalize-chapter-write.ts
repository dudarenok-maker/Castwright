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
import { buildCastResolver } from '../store/cast-resolve.js';
import type { CastIdHistory } from '../store/cast-id-history.js';
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
  /** #3362 finding 3 — the `cast-id-history.json` state THIS render actually
      resolved its cast ids against, threaded through by the caller rather
      than re-read here. All three callers already load this once at the top
      of their handler (to build the render's own resolver / pass to
      `synthesiseChapter`); re-reading it here raced a mid-render edit — a
      pair rejected (or a retirement recorded) after synthesis started but
      before this write landed resolved against a DIFFERENT, newer history
      than the one the render's segments actually reflect, silently dropping
      or misfolding a character's snapshot. Passing the same object the
      caller resolved against closes that window. */
  castIdHistory: CastIdHistory;
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
  /** #3362 pass-5 fix (🟠E, owner design (i)) — indices into `segments` this
      write actually RE-SYNTHESISED (fresh TTS audio, produced by THIS call).
      Absent means every segment was — the shape of a full render
      (`generation.ts` never sets this, matching "initial full render = all
      segments re-synthesized"). `chapter-splice.ts`'s `rerecord` mode and
      `chapter-qa-repair.ts` pass the exact indices their own synth loop
      touched; a `remix` (gain) pass passes an empty set — a gain changes
      volume, not voice, so nothing was actually re-synthesised.

      A segment OUTSIDE this set had its audio untouched by this write, so
      its identity must not be re-derived from the CURRENT (mutable) cast +
      cast-id-history either — the same freeze already applied to
      `castHistorySeq` above, for the same reason: a re-finalize must not
      re-arm identity drift for lines it never touched. See the stamping
      block below for the mechanics (the class this closes: 🟠E / R1-R4). */
  resynthesizedIndices?: Iterable<number>;
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

  /* #3362 — resolve each raw segment characterId through the Wave-1 cast
     resolver so speakingIds / fallbackByChar / voiceNameByChar carry the
     CANONICAL cast id (e.g. segment 'the-torment' -> cast 'the_torment' via
     the normalised-id tier), which is the key buildCharacterSnapshots matches
     on. A genuinely unresolvable or rejected id falls back to the raw id — no
     live cast entry carries that key, so it produces no snapshot entry
     exactly as before the fix.

     #3362 finding 5 — this only guarantees THIS render's own maps are keyed
     canonically. It does NOT, by itself, make the C1 carry-forward below
     match: that reads a PRIOR *file's* `characterSnapshots`, whose keys were
     stamped by whatever render wrote that file — a spelling that can since
     have been retired via `retireCharacterId`. Re-keying THIS render's ids
     through the resolver says nothing about ids the resolver never sees. The
     carry-forward re-resolves the prior file's own keys separately, below.

     #3362 finding 3 — `castIdHistory` comes from the caller (see
     `FinalizeChapterAudioInput.castIdHistory`'s doc comment), NOT a fresh
     `loadCastIdHistory(bookDir)` read here: re-reading raced a mid-render
     edit to `cast-id-history.json` against the history the render actually
     resolved segments' ids against. */
  const castResolver = buildCastResolver(cast, input.castIdHistory);
  const resolveSpeakingId = (rawId: string): string =>
    castResolver.resolve(rawId)?.character.id ?? rawId;

  /* #3362 pass-5 fix (🟠E, owner design (i)) — `resynthesizedIndices` (see
     its own doc comment on `FinalizeChapterAudioInput`) splits `segments`
     into the ones THIS write actually re-synthesised (default: all of
     them — a full render) and the ones it merely carried through byte-
     identical (a re-finalize's untouched lines). Only the former feed fresh
     resolution below; the latter are frozen further down, at the
     characterSnapshots merge and the stamping block. */
  const resynthesizedIndexSet: Set<number> = input.resynthesizedIndices
    ? new Set(input.resynthesizedIndices)
    : new Set(segments.map((_, i) => i));
  const untouchedIndices = segments.map((_, i) => i).filter((i) => !resynthesizedIndexSet.has(i));

  const speakingIds = new Set<string>();
  const fallbackByChar = new Map<string, string>();
  /* #1972 — the voice ACTUALLY sent to the provider per character, read back
     from this render's own segments rather than re-derived from the cast
     record. See buildCharacterSnapshots' voiceNameByChar doc for why.
     M1 — prefer `baseVoiceName` (pre-emotion-variant) over the exact
     per-segment `voiceName`, so a character whose LAST speaking segment this
     run happens to be an emotion-tagged quote doesn't get the variant's
     `__<emotion>`-suffixed name stamped as its resolved voice. */
  const voiceNameByChar = new Map<string, string>();
  for (const i of resynthesizedIndexSet) {
    const s = segments[i];
    const resolved = resolveSpeakingId(s.characterId);
    speakingIds.add(resolved);
    if (s.renderedFallbackEngine) fallbackByChar.set(resolved, s.renderedFallbackEngine);
    const voiceName = s.baseVoiceName ?? s.voiceName;
    if (voiceName) voiceNameByChar.set(resolved, voiceName);
  }

  /* Read the prior file once, when there's anything this write can't derive
     fresh: an untouched segment (needs its own prior stamp/snapshot carried
     forward, below) or C1's gap (needs the prior voiceName). Absent on a
     genuine first render, where neither condition holds. */
  const needsPriorFile = untouchedIndices.length > 0 || voiceNameByChar.size < speakingIds.size;
  const priorFile = needsPriorFile ? await readJson<ChapterSegmentsFile>(segPath).catch(() => null) : null;

  /* #3362 finding 5 — the prior file's `characterSnapshots` keys were
     stamped by whatever render wrote that file, which can predate a
     retirement recorded since (`retireCharacterId`): a snapshot the prior
     render wrote under 'old' is invisible to a `speakingIds.has(id)` lookup
     once cast-id-history has since folded 'old' into 'new', even though
     'old'/'new' are the same character. Re-key the prior snapshots through
     the same resolver used above so a snapshot stored under a retired (or
     otherwise non-canonical) id is still found under its canonical id.
     Two prior keys can resolve to the same canonical id (the canonical id
     itself, still present verbatim, plus a retired alias for the same
     character) — prefer the exact canonical-key entry over a resolved
     alias, since it's the one the prior render itself wrote under the
     character's own id rather than reached only by reading through
     history. Reused below by both C1 (voiceName gap) and the pass-5
     untouched-segment carry-forward. */
  const priorSnapshotsByCanonicalId = new Map<string, CharacterSnapshot>();
  for (const [rawKey, snapshot] of Object.entries(priorFile?.characterSnapshots ?? {})) {
    const canonicalId = castResolver.resolve(rawKey)?.character.id ?? rawKey;
    const isExactKey = canonicalId === rawKey;
    if (isExactKey || !priorSnapshotsByCanonicalId.has(canonicalId)) {
      priorSnapshotsByCanonicalId.set(canonicalId, snapshot);
    }
  }

  /* C1 (#1972 follow-up) — a character can be "speaking" in the resynthesized
     set (it has a resynthesized segment) without that segment's own take
     having carried a `voiceName` (a defensive gap-fill; every genuine
     re-record sets it — see `SynthOutput.voiceName`'s doc). Nothing was
     actually re-synthesised with a NEW voice for these characters, so the
     LAST render's own recorded voice is still the truthful answer: carry it
     forward from the prior segments file, read above BEFORE
     `preserveExistingAsPrevious` renames it to `.previous.segments.json`
     below. */
  if (voiceNameByChar.size < speakingIds.size) {
    for (const id of speakingIds) {
      if (voiceNameByChar.has(id)) continue;
      const priorVoice = priorSnapshotsByCanonicalId.get(id)?.resolvedVoiceName;
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

  /* #3362 pass-5 fix (🟠E, owner design (i)) — a character that speaks ONLY
     in untouched segments this write (never in the resynthesized set) gets
     no fresh snapshot above — `buildCharacterSnapshots` never saw its id in
     `speakingIds`. Carry its EXISTING snapshot entry forward from the prior
     file verbatim instead of leaving it un-snapshotted: nothing about that
     character changed this write, so nothing about its snapshot (tone,
     voiceEngine, resolvedVoiceName, …) should either. Never re-resolved
     through the current cast/history, which is exactly the re-derivation
     this fix closes (R4: a raw id that resolves differently today than at
     its last render must not silently repaint an untouched line).

     Identified by the segment's OWN existing stamp (`resolvedCharacterId`)
     when it has one — but a LEGACY untouched segment predating the stamp
     (R4's A22 shape: rendered before pass-4 shipped) has none, and its
     identity has always lived at its raw `characterId`, exact-matched
     against the chapter's own snapshot keys (the same fallback every
     downstream reader already applies — see `ChapterSegment
     .resolvedCharacterId`'s doc comment). So an untouched, unstamped
     segment's effective key falls back to its raw id too, and the carry-
     forward below looks it up the same way — otherwise a legacy chapter
     that was never stamped in the first place would lose its ALREADY-
     WORKING exact-match snapshot the moment it's re-finalized, which is a
     regression this fix must not introduce. */
  const untouchedStampedIds = new Set<string>();
  for (const i of untouchedIndices) {
    const id = segments[i].resolvedCharacterId ?? segments[i].characterId;
    if (!speakingIds.has(id)) untouchedStampedIds.add(id);
  }
  for (const id of untouchedStampedIds) {
    if (characterSnapshots[id]) continue; // the fresh set already covers it
    const carried = priorFile?.characterSnapshots?.[id];
    if (carried) characterSnapshots[id] = carried;
    // No prior entry to carry forward — an untouched segment whose id (raw
    // or stamped) never named a real snapshot key even at its last render.
    // A stamped one is handled by the stamping block's R1 clearing below;
    // an unstamped one was already invisible to a raw exact-match lookup
    // before this fix, so leaving it out here changes nothing for it.
  }

  /* #3362 pass-4 fix (🟠D / owner design a), refined by pass-5 (🟠E, owner
     design (i)) — stamp each segment with the canonical id THIS WRITE
     resolved it to, ONLY when that id is a real key in THIS write's own
     `characterSnapshots` (fresh + the carry-forward above) — otherwise no
     stamp (see `ChapterSegment.resolvedCharacterId`'s own doc comment).
     Render-integrity scoring, qa-report.ts and chapter-qa-repair.ts read
     this stamp back instead of re-resolving `characterId` through the
     CURRENT, mutable cast-id-history at scoring/repair time — a later
     retirement, reject, or bridge added after this render must never change
     which identity this render's own rows score under.

     A resynthesized segment is resolved fresh, exactly as pass-4 did — that
     audio genuinely changed (or was newly minted) this write, so its
     identity is decided fresh, every time, unconditionally overwriting
     whatever it carried before (never inherits a stale stamp from an
     identity that no longer resolves).

     An UNTOUCHED segment keeps its EXISTING stamp verbatim — it is never
     re-resolved — UNLESS that stamp names a key still absent from this
     write's characterSnapshots even after the carry-forward above (R1: e.g.
     the character was rejected/retired out of the cast entirely since its
     last render, so there is no snapshot to carry forward for it at all).
     A stamp pointing at an absent key is worse than no stamp: a later
     scoring/repair pass could join it, by raw string equality, against some
     OTHER chapter's unrelated snapshot that happens to share the same key —
     so it is cleared instead, same as a segment that never resolved at
     render time. */
  const stampedSegments: ChapterSegment[] = segments.map((s, i) => {
    if (resynthesizedIndexSet.has(i)) {
      const resolved = resolveSpeakingId(s.characterId);
      return { ...s, resolvedCharacterId: characterSnapshots[resolved] ? resolved : undefined };
    }
    return s.resolvedCharacterId && !characterSnapshots[s.resolvedCharacterId]
      ? { ...s, resolvedCharacterId: undefined }
      : s;
  });

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
    segments: stampedSegments,
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

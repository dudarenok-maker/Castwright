/* Per-chapter synthesis pipeline.

   Strategy: fold the chapter's sentences into consecutive same-speaker runs
   ("sentence groups"), synthesise each group as one TTS call, then concatenate
   the PCM in narrative order. Per-group durations become segments on the
   chapter output. This dramatically cuts the call count vs per-sentence while
   still giving us per-group timing for the future playback slice. */

import type { Emotion, SentenceOutput } from '../handoff/schemas.js';
import {
  pickVoiceForEngine,
  pickEmotionVariantVoice,
  type CharacterHint,
  type VoiceLike,
} from './voice-mapping.js';
import { resolveInstructForGroup } from './resolve-instruct.js';
import type { TtsEngine, TtsModelKey, TtsProvider, SynthesizeBatchOutput } from './index.js';
import { resolveCharacterEngine, resolveCharacterQwenTier } from './per-character-engine.js';
import { normaliseForTts, stripAudioTags } from './text-normalize.js';
import { normaliseBookLanguage } from './language.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import { pcmDurationSec } from './pcm.js';
import { configValue } from '../config/resolver.js';
import { evaluateSegmentPcm, type SegmentQaVerdict, type SegmentQaThresholds } from './segment-qa.js';
import {
  looksLikeCalibrationBleed,
  verifySegmentTranscript,
  leadingVocalizationTokens,
  type AsrClassification,
  type AsrThresholds,
} from './segment-asr-qa.js';
import type { TranscribeResult } from './transcribe-client.js';
import { embedSegment } from './embed-client.js';
import {
  type EmbeddingRow,
} from '../audio/render-integrity/embeddings-io.js';
import { MIN_DURATION_SEC } from '../audio/render-integrity/constants.js';
import { textHashForStale } from '../audio/segments-io.js';
import { resamplePcm16 } from './resample-pcm16.js';
import { withTtsRetry, isTransient } from './retry.js';
import { getResolvedSidecarUrl, getLastKnownCoquiInstallState } from '../workspace/user-settings.js';
import {
  UnresolvableClonedVoiceError,
  resolveClonedVoicesForChapter,
  resolveDesignedVoicesForChapter,
  type ResolveChapterDeps,
  type ResolveDesignedVoiceDeps,
} from './clone-voice-resolver.js';
import {
  readEntry,
  writeEntry,
  updateEntry,
  entryDir,
  type VoiceLibraryEntry,
} from '../workspace/voice-library.js';
import { purgeCloneArtifacts, evictSidecarVoice } from '../workspace/purge-clone-artifacts.js';
import { deriveEngineArtifact } from './derive-engine-artifact.js';
import { currentQwenBaseModel } from './model-paths.js';
import { getLastKnownCoquiVersion } from './coqui-version-state.js';
import {
  manifestSlotFor,
  type CloneEngine,
  CLONE_ENGINE_LIST,
  isCloneEngine,
  characterHasClonedSlot,
  hasClonedProvenance,
  libraryVoiceForEngine,
  cloneStorageKey,
} from './clone-engines.js';
import { decodeAudioToPcm } from './mp3.js';
import {
  qwenVoicePtPath,
  qwenVoiceSidecarPath,
  qwenVoiceWavPath,
  xttsVoiceLatentsPath,
} from '../workspace/paths.js';
import { safeSegment, sanitizeIdSegment, assertContained } from '../util/safe-path.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/* Default body-group dispatch width for a GPU engine (kokoro/coqui/qwen), and
   the flag-OFF safety invariant for the whole capacity-aware-placement
   feature: ONE synth call in flight at a time per render. This used to
   default to `gpuSemaphore.maxConcurrency` (the now-removed process-wide
   weighted VRAM semaphore); admission/serialization against other renders and
   engines lives in the sidecar now (`_synth_lock` + the sidecar load locks),
   so this module has no cross-book coordination left to lean on — a width > 1
   here would let a single render's OWN groups race each other against that
   per-process GPU. The Qwen throughput lever is `/synthesize-batch` (packing
   many sentences into one call), NOT raising concurrent `/synthesize` calls —
   do not raise this default. */
const DEFAULT_SENTENCE_CONCURRENCY = 1;

/* How many Qwen sentences to pack into one batched `generate_voice_clone`
   call (plan 112 — true batching). Read once at module load; `=1` is an
   instant per-call kill-switch (every Qwen sentence becomes a single synth,
   byte-identical to pre-112). When `QWEN_BATCH_TOKEN_BUDGET` is on (the default
   now), this is the HARD width cap the token budget clamps to. Default 32 —
   adopted 2026-05-30 after the plan-136 live A/B on the 8 GB box (cap 32 /
   budget 3600); lower it (or the budget) if a smaller card OOMs. Only Qwen
   batches; Coqui/Kokoro/Gemini sentences always synth one-per-call. */
const QWEN_BATCH_SIZE = configValue<number>('tts.batch.size');

/* Length-bucketing (plan 128). A batched Qwen forward decodes for as many
   steps as the LONGEST item in the batch, padding the shorter ones; so a
   batch's compute is `max_length × per_step` while its audio is `Σ length_i`.
   Sorting the batchable groups by length before slicing packs similar-length
   sentences together → each batch decodes to a tight `max ≈ avg`, maximising
   audio-produced-per-step. Output-preserving (per-sentence prompts + index
   scatter-back), so audio is byte-identical regardless of batch composition.
   Default ON; `QWEN_BATCH_BUCKET=0` (or `false`) reverts to index-order. */
const QWEN_BATCH_BUCKET = configValue<boolean>('tts.batch.bucket');

/* Token-budget packing (plan 136). A batched Qwen forward decodes to its
   LONGEST item and pads the rest, so its VRAM/compute proxy is
   `count × maxLenInBatch`, not `count`. Fixed-width slicing (plan 113) caps
   only `count`, so a batch of long sentences costs far more than a batch of
   short ones at the same width — forcing a conservative width that leaves
   short/dialogue batches narrower than VRAM allows (exactly where RTF is
   worst, since the per-batch dispatch cost is amortised over little audio).
   This knob switches the packer to a VARIABLE-width greedy fill: keep adding
   the next (ascending-length-sorted) item while `(count+1) × candidateMaxLen
   <= budget`, so short batches pack wide (lower RTF via dispatch amortisation)
   and long batches stay narrow (no OOM). Units = normalised-text chars.
   `QWEN_BATCH_SIZE` stays the HARD width cap. UNSET = the shipped default
   (3600, adopted 2026-05-30 after the plan-136 live A/B); an explicit `0` is
   the fixed-width kill-switch + back-compat path. Output-preserving (per-item
   prompts + index scatter-back), same as plan 128. */
export const DEFAULT_QWEN_BATCH_TOKEN_BUDGET = 3600;

/** Resolve `QWEN_BATCH_TOKEN_BUDGET` from a raw env string. Unset / empty →
    the shipped default (token-budget packing ON); an explicit `0` (or a
    non-positive / non-numeric value) → `0` = OFF, the fixed-width kill-switch.
    Exported for unit coverage so the unset-vs-0 parsing contract stays pinned.
    The module-level constant routes through the registry so env vars AND app
    overrides take effect. */
export function resolveQwenTokenBudget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_QWEN_BATCH_TOKEN_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
const QWEN_BATCH_TOKEN_BUDGET = configValue<number>('tts.batch.tokenBudget');

/* 1.7B tier-aware batch width. The packer applies these caps to the 1.7B bucket
   ONLY; 0.6B batches keep the defaults above (a mixed-tier chapter packs each
   tier to its own width). Defaults now MATCH the 0.6B tier (32 / 3600): the
   #1162 readiness-gate fix evicts the unused 0.6B base before a 1.7B run, so the
   1.7B-Base (~3.4 GB) is no longer co-resident and 32/3600 fits an 8 GB card
   (measured peak ~5.7 GB, ~1.7 GB margin under the recycle line) at ~2× RT.
   These knobs remain the small-card safety valve — lower them if a 1.7B render
   trips the VRAM recycle on a < 8 GB card. */
export const DEFAULT_QWEN_BATCH_TOKEN_BUDGET_17B = 3600;
const QWEN_BATCH_SIZE_17B = configValue<number>('tts.batch.size17b');
const QWEN_BATCH_TOKEN_BUDGET_17B = configValue<number>('tts.batch.tokenBudget17b');

/* Defensive per-call ceiling (plan 148). A single provider call that never
   returns — e.g. Qwen's open-ended decode running away on degenerate, non-prose
   input (a table-of-contents page, a copyright block) — would otherwise hang the
   chapter, and with it the whole generation queue, indefinitely (the 2026-05-31
   the Hollow Tide stall). Bounding each call turns that infinite hang into a single
   chapter failure the queue rides past. Generous default (10 min) — far above
   any legitimate single batch (~250 s for 32 sentences). `0` disables. */
const SYNTH_CALL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.SIDECAR_CALL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 600_000;
})();

/** Thrown when a single synth call exceeds {@link SYNTH_CALL_TIMEOUT_MS}.
    Non-transient by construction (it is thrown OUTSIDE `withTtsRetry`, so it is
    never replayed) — it bubbles out of `synthesiseChapter` as a normal
    chapter failure, letting the queue advance past a degenerate chapter. */
export class ChapterSynthTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(
      `TTS ${label} call exceeded ${Math.round(ms / 1000)}s with no result — ` +
        `likely runaway/degenerate input. Skipping this chapter so the queue can advance.`,
    );
    this.name = 'ChapterSynthTimeoutError';
  }
}

/** Thrown by the generation loop's per-chapter no-progress watchdog when a
    chapter makes NO forward progress (no group/batch completes, and no assembly
    milestone lands) for longer than the configured window. Distinct from
    {@link ChapterSynthTimeoutError} (a single synth CALL ceiling) — this is the
    whole-chapter catch-all that also covers the post-synth assembly phase
    (encode / ffmpeg loudnorm / disk), which has no per-call timeout. It is NOT
    an AbortError, so the generation loop records it as a durable
    `generationError` instead of silently swallowing it as a pause. The
    2026-06-02 the drowning bell ch52 stall was exactly this: no progress, no error,
    no breadcrumb. */
export class ChapterStallError extends Error {
  constructor(ms: number, phase: 'synthesis' | 'assembly') {
    super(
      `Chapter made no progress for ${Math.round(ms / 1000)}s during ${phase} — ` +
        `aborting so the failure is recorded and the queue can advance. ` +
        `Check the TTS sidecar (it may be wedged or memory-saturated).`,
    );
    this.name = 'ChapterStallError';
  }
}

/** Thrown by synthesiseChapter when the in-loop recycle-recovery budget
    (`maxRecycleRecoveries`) is exhausted on a single chapter — i.e. the sidecar
    recycled/respawned more times than allowed while this one chapter rendered.
    A NAMED signal (C3) so generation.ts can surface "the sidecar is thrashing —
    likely the host-memory leak (side-11) or insufficient headroom" instead of a
    generic mid-synth failure. Carries the recovery count + the last underlying
    error for the log. */
export class RecycleStormError extends Error {
  readonly recoveries: number;
  readonly lastError: unknown;
  constructor(recoveries: number, lastError: unknown) {
    super(
      `The TTS sidecar recycled ${recoveries}× while rendering this single chapter ` +
        `— it is likely thrashing (host-memory leak or insufficient VRAM/RAM headroom). ` +
        `Stopping so the run doesn't grind. Restart the sidecar / lower concurrency, then Retry.`,
    );
    this.name = 'RecycleStormError';
    this.recoveries = recoveries;
    this.lastError = lastError;
  }
}

/* fs-2 — thrown when a character on a non-English book has no designed Qwen
   voice and the Kokoro fallback is forbidden (`forbidKokoroFallback`). Kokoro
   is English-only, so silently falling back would read the book's language
   (e.g. Russian) through an English voice — cross-language garbage. We fail
   the chapter LOUDLY instead, naming the character so the user can design its
   voice in the cast view. */
export class MissingDesignedVoiceError extends Error {
  constructor(characterName: string, language: string, detail?: string) {
    super(
      `Character "${characterName}" has no designed voice for this ${language} book — ` +
        `design a voice for it (and the narrator) in the cast view before generating. ` +
        `English Kokoro voices cannot read ${language} text.` +
        (detail ? ` ${detail}` : ''),
    );
    this.name = 'MissingDesignedVoiceError';
  }
}

/* fs-38 Wave 3b1 (C1) — a cloned-provenance Qwen group must never be silently
   substituted. When Qwen is unavailable this run, applyQwenFallback raises this
   instead of rerouting to Kokoro/Coqui — a real person's voice is never swapped
   for another. Moved to clone-voice-resolver.ts in 3b2 (T4) so the resolver
   module (which synthesiseChapter will import) can define it without an
   import cycle; re-exported here so existing importers keep working. */
export { UnresolvableClonedVoiceError } from './clone-voice-resolver.js';

/* Identify the input that hung when a synth call times out. We couldn't tell
   what the 2026-05-31 ch29 ChapterSynthTimeoutError choked on, so on a timeout
   log the offending group(s): sentence id(s), speaker, the longest item's char
   count, and a truncated prefix. Self-service observability — a follow-up can
   then scope the actual degenerate-input root cause from data, not a guess. */
function logSynthTimeoutOffender(err: unknown, groups: SentenceGroup[]): void {
  if ((err as { name?: string })?.name !== 'ChapterSynthTimeoutError') return;
  const longest = groups.reduce(
    (a, b) => (normaliseForTts(b.text).length > normaliseForTts(a.text).length ? b : a),
    groups[0],
  );
  const sentText = normaliseForTts(longest.text);
  const ids = groups.flatMap((g) => g.sentenceIds).join(',');
  const preview = sentText.length > 200 ? `${sentText.slice(0, 200)}…` : sentText;
  console.warn(
    `[generation] synth timeout offender — sentenceIds=[${ids}] speaker=${longest.characterId} ` +
      `longestLen=${sentText.length} text="${preview}"`,
  );
}

/** Matches the on-disk cast.json shape (see `server/src/routes/voices.ts`
    `CastJsonCharacter` and the analyzer's Character output). The hint fields
    — description/role/gender/ageRange/tone/evidence — are what drives
    `pickVoiceForEngine` away from the narrator fallback for non-narrator
    characters. Dropping them here forces every character without a gendered
    word in its name/attributes to land on narrator-cool, which manifested as
    Oduvan and Ro speaking in the narrator's voice. */
export interface CastCharacter {
  id: string;
  name?: string;
  role?: string;
  voiceId?: string;
  /** srv-43 — immutable per-voice identity (nanoid) minted at design time.
      The Qwen storage key derives from it (qwen-<voiceUuid>); absent on
      voices designed before srv-43 (legacy name-keyed fallback). */
  voiceUuid?: string;
  attributes?: string[];
  /** Alternate names from cast.json. Not used by synthesis, but the voice
      library (routes/voices.ts) copies it onto each derived Voice so the
      cross-book duplicate detector can apply its already-linked suppression
      without hydrating every foreign cast (plan 101 bug fix 2026-05-26). */
  aliases?: string[];
  /** Cross-book "intentionally separate" pairs from cast.json. Surfaced on
      the derived Voice for the same reason as `aliases`. */
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
  description?: string;
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  /** cast.json stores evidence as `{ quote?, note? }[]`; `pickVoiceForEngine`
      consumes a `string[]` of bare quotes. `buildHintFromCast` does the
      flattening. */
  evidence?: Array<{ quote?: string; note?: string } | string>;
  /** Natural-language voice-design persona (plan 108). Generated per
      character by Gemini and editable by the user; seeds the Qwen sidecar's
      bespoke voice-design flow. Persisted in cast.json. */
  voiceStyle?: string;
  /** Per-engine user-set voice overrides. The active synth engine reads
      its own slot; missing slots fall through to attribute inference.
      Persisted in cast.json so it survives reloads + analysis reparses.
      Switching engines (Coqui ↔ Kokoro) preserves cast assignments
      because each engine has its own slot. */
  overrideTtsVoices?: Partial<
    Record<
      TtsEngine,
      {
        name: string;
        /** fs-38 Wave 1 — set when this slot's speaker is sourced from a
            voice-library entry rather than an ad-hoc per-character design.
            Lets `scanLibraryVoiceUsage` (workspace/voice-library-usage.ts)
            find every character referencing a given library voice for the
            DELETE usage report + confirm flow. */
        libraryUuid?: string;
        /** Mirrors the library entry's own `provenance` at assignment time. */
        provenance?: 'designed' | 'cloned' | 'imported';
        variants?: Partial<Record<Emotion, { name: string }>>;
      }
    >
  > | null;
  /** @deprecated Legacy singular override. Read paths normalise this
      into `overrideTtsVoices` at cast.json load time (see
      `normaliseCastCharacter` in routes/voices.ts). Kept on the type so
      cast.json files written by older clients still satisfy this
      interface before normalisation. */
  overrideTtsVoice?: { engine: TtsEngine; name: string } | null;
  /** Per-character engine (plan 108). When set, this character is synthesised
      through this engine (e.g. `'qwen'` for a bespoke voice) regardless of the
      run's default engine; absent → the run default. The narrator typically
      leaves this unset and stays on the default (Kokoro). */
  ttsEngine?: TtsEngine | null;
  /** fs-56 — per-character model-key override for the Qwen engine, meant to
      ELEVATE one character above the run's default (e.g. `'qwen3-tts-1.7b'`
      to route just this character to the 1.7B-Base in an otherwise-0.6B run).
      Resolved via `higherQwenTier` against the run default, so it only ever
      raises the effective tier — a character stuck on a stale/unset 0.6B
      value can never downgrade a run (or per-regenerate override) that was
      explicitly started at 1.7B. Ignored for non-Qwen characters. Absent /
      null → run default. */
  ttsModelKey?: TtsModelKey | null;
}

export interface SentenceGroup {
  /** Position in narrative order (0-based). */
  index: number;
  characterId: string;
  /** Sentence ids folded into this group, in order. */
  sentenceIds: number[];
  /** Concatenated sentence text. */
  text: string;
  /** fs-25 — the quote's delivery emotion (one group = one sentence since plan
      70d). Drives Qwen emotion-variant voice selection in `resolveGroup`;
      absent/`neutral` → the base voice. Ignored entirely for non-Qwen engines. */
  emotion?: Emotion;
  /** fs-57 — optional explicit delivery direction authored by Stage 3. When
      set and the speaker is on the 1.7B tier it takes precedence over the
      emotion phrase; ignored on all other paths. */
  instruct?: string;
  /** fs-57 — true when Stage 3 authored a non-verbal vocalization into `text`.
      Drives the srv-31 ASR carve-out. Absent = normal sentence. */
  vocalization?: boolean;
}

export interface ChapterSegment {
  groupIndex: number;
  characterId: string;
  sentenceIds: number[];
  /** Inclusive start time in the chapter audio, in seconds. */
  startSec: number;
  /** Exclusive end time in the chapter audio, in seconds. */
  endSec: number;
  /** #1105 — djb2-base36 hash of this group's TAG-STRIPPED sentence text (inline
      audio tags removed, matching the frontend staleness diff), stamped so the frontend
      can flag a chapter whose text was edited after it rendered (synth is keyed on
      text → stale on every engine). Absent on the title beat (no manuscript sentence)
      and on pre-#1105 renders. See audio/segments-io.ts textHashForStale. */
  textHash?: string;
  /** fs-58 (#1041) — djb2-base36 hash of this group's RAW explicit `instruct`,
      stamped ONLY when the group rendered on the qwen-1.7b tier (so an instruct
      edit can stale the chapter only where the instruct shaped the audio).
      The instruct sibling of `textHash`. Absent otherwise. */
  instructHash?: string;
  /** Discriminator for synthetic segments that aren't backed by a manuscript
      sentence. `'title'` marks the narrator-voiced chapter-title beat
      prepended to each chapter (see CHAPTER_LEAD_SILENCE_SEC below). Body
      sentences leave this field undefined so the on-disk segments.json
      shape stays backwards-compatible with pre-title chapters. */
  kind?: 'title';
  /** Engine this segment ACTUALLY rendered in when it differs from the
      character's configured engine — set to `'kokoro'` when a Qwen character
      with no designed voice (or an unavailable Qwen engine) fell back to
      Kokoro. Undefined = rendered in the configured engine. Drives the
      "Fallback (Kokoro)" status in the UI. */
  renderedFallbackEngine?: TtsEngine;
  /** #2023 Piece 1 — the cast character id that ACTUALLY spoke this line when
      `characterId` above is an ORPHANED id (no entry in this book's cast at
      all) and the render's orphaned-characterId safety net substituted the
      narrator for it (see the "which is not in this book's cast" warning in
      `resolveGroup`). `characterId` is deliberately left as the ORIGINAL
      (orphaned) id — every existing consumer (revisions drift detector, the
      srv-36 audition anchors) keys off the manuscript's own attribution —
      so this field is the ONLY place the substitution itself is recorded.
      Undefined on every normally-resolved segment. Aggregated across a
      book's rendered chapters by `collectOrphanedCharacterFallbacks`
      (segments-io.ts) into the book-state response, mirroring how
      `renderedFallbackEngine` is aggregated by `collectRenderedFallbackEngines`. */
  renderedFallbackCharacterId?: string;
  /** The voice this segment REQUESTED, set only when the sidecar substituted a
      safe fallback because the requested voice wasn't in its speaker manifest
      (its `X-Voice-Substituted-From` header). Absent on a clean render. Surfaces
      a silent voice fallback so the golden-audio gate can fail on it. */
  voiceSubstitutedFrom?: string;
  /** #1972 — the voice name ACTUALLY sent to the provider for this segment
      (post-fallback, post-emotion-variant — `resolveGroup(group).voiceName`
      for a body group, the title beat's own resolved narrator voice for
      `kind: 'title'`). `buildCharacterSnapshots` reads this back per character
      instead of re-deriving `resolvedVoiceName` from the cast record, so the
      snapshot can never claim a voice that was never requested — the
      provenance gap `character-snapshots.ts` used to have. */
  voiceName?: string;
  /** M1 (#1972 follow-up) — the same voice, minus any `__<emotion>` variant
      suffix `pickEmotionVariantVoice` may have appended to `voiceName` for a
      single tagged quote. `finalize-chapter-write.ts` collects THIS field
      (falling back to `voiceName`) into the per-CHARACTER snapshot, so a
      character whose LAST-rendered segment happened to be an emotion-tagged
      quote doesn't get its `resolvedVoiceName` stamped with the variant's
      suffixed name — which would permanently false-flag "Voice" drift
      against every consumer that expects the base voice (revisions.ts, the
      Voices Designed/Generated split, the srv-36 audition centroid). Equal
      to `voiceName` whenever no variant applied (every non-Qwen engine, a
      fallback reroute, an untagged/neutral quote, or the title beat). */
  baseVoiceName?: string;
  /** Per-sentence pre-assembly QA verdict (segment-qa.ts). Set only when the
      gate ran (`maxSegmentRerecords > 0`); absent on the title beat and on
      legacy chapters synthesised before the gate landed. */
  qa?: SegmentQaVerdict;
  /** True when this segment is still `suspect` after the gate exhausted its
      re-records (the best-of-N take was kept and assembled anyway). Drives the
      per-sentence suspect surface; undefined when the gate passed or did not
      run. */
  suspect?: boolean;
  /** fs-51 — number of times this segment was actually re-recorded by the
      signal-QA gate (not merely "still suspect" — an attempt that fixed the
      line still counts). 0/undefined on the title beat and when the gate
      didn't run for this segment. */
  qaRetries?: number;
  /** ASR content-QA verdict (srv-31) — transcript vs manuscript word-error-rate.
      Set only when the ASR pass ran (`opts.asr` provided); absent on the title
      beat and on chapters synthesised without ASR. Carries the transcript + WER
      breakdown + intrinsic signals for the per-chapter QA report. */
  asr?: AsrClassification;
  /** True when this segment is still `drift` after the ASR pass exhausted its
      re-records (best-of-N by WER kept and assembled anyway) — the
      "fluent but wrong words" surface. Undefined when ASR passed, was
      inconclusive, or did not run. */
  asrSuspect?: boolean;
  /** fs-51 — same as `qaRetries`, for the ASR content-QA gate's re-record loop. */
  asrRetries?: number;
  /** True when this segment's audio bled the voice-design calibration clip
      (#1083) and was QUARANTINED — its take was dropped (replaced with brief
      silence) rather than shipped, after the ASR re-record budget failed to
      recover it. A hard `suspect` flag rides alongside. Undefined otherwise. */
  quarantined?: boolean;
}

/** Silence padding bookending the spoken chapter-title narration. Each chapter
    MP3 now opens with `[lead silence] + [narrator: title] + [post silence] +
    [body sentences]`. Defaults match standard audiobook chapter breaks —
    3.0 s of total padding is enough for the listener to register the
    boundary without dragging. Tuned together with the documented invariant
    in `docs/features/archive/28-chapter-audio-format.md`; adjust both at once. */
const CHAPTER_LEAD_SILENCE_SEC = 1.5;
const CHAPTER_POST_TITLE_SILENCE_SEC = 1.5;

/** Brief silence that replaces a quarantined calibration-bleed take (#1083) —
    enough to preserve a perceptible sentence slot in the timeline without
    subjecting the listener to the (typically runaway-long) bled clip. */
const QUARANTINE_SILENCE_SEC = 0.3;

/** Build a zero-filled mono 16-bit LE PCM buffer of the requested duration.
    Matches the per-chapter PCM contract — same byte layout as what the TTS
    providers return, so the rest of the synth pipeline (concat, encode,
    loudnorm) treats it identically to spoken audio. */
function buildSilencePcm16(sampleRate: number, seconds: number): Buffer {
  const samples = Math.round(sampleRate * seconds);
  return Buffer.alloc(samples * 2);
}

export interface ChapterSynthesisResult {
  /** Concatenated 16-bit signed LE mono PCM, sample rate per `sampleRate`. */
  pcm: Buffer;
  sampleRate: number;
  durationSec: number;
  segments: ChapterSegment[];
  /** srv-36 render-integrity: one embedding row per stochastic-engine group
      of ≥ MIN_DURATION_SEC. Populated only when `qa.speaker.enabled` is on;
      absent (undefined) when the gate is off or no eligible groups exist. */
  embeddings?: EmbeddingRow[];
  /** B1 QA-cost split (ms). `rerecordMs` is QA-driven re-record synth wall (the
      part the gate fixes move); `transcribeMs`/`embedMs` are the always-on verify
      floor. Zero when the corresponding gate did not run. */
  rerecordMs: number;
  transcribeMs: number;
  embedMs: number;
}

/** Minimal shape of a synthesis result as seen by the embed pass. */
interface GroupPcmResult {
  pcm: Buffer;
  sampleRate: number;
}

/** srv-36: Collect ECAPA embeddings for stochastic-engine groups that meet the
    duration floor. Extracted as a pure(ish) helper so it can be unit-tested
    without running a full synthesis pipeline.

    @param groups   The sentence groups in narrative order.
    @param results  The per-group synthesis results (indexed by group.index).
    @param resolvedEngineFor  Maps group.index → the CONFIGURED engine for that
           group (after fallback resolution, so a Qwen→Kokoro fallback shows
           'kokoro' and is correctly excluded).
    @param embedFn  Injected at test time; defaults to `embedSegment`.
    @returns        One EmbeddingRow per eligible group, in group order. */
export async function collectGroupEmbeddings(
  groups: SentenceGroup[],
  results: (GroupPcmResult | undefined)[],
  resolvedEngineFor: (index: number) => TtsEngine,
  embedFn: (pcm: Buffer, sampleRate: number) => Promise<Float32Array> = embedSegment,
  /** Fired after each ACTUAL embed completes (not for skipped groups). The
      route wires this to the per-chapter no-progress watchdog: the embed pass
      is CPU-bound, runs after synthesis with no SSE tick of its own, and on a
      long chapter could otherwise be killed mid-flight by the 720s stall guard
      (sibling of #1029's assembly stall). */
  onEmbed?: () => void,
): Promise<EmbeddingRow[]> {
  const rows: EmbeddingRow[] = [];
  for (const group of groups) {
    const r = results[group.index];
    if (!r) continue;
    const engine = resolvedEngineFor(group.index);
    if (engine !== 'qwen' && engine !== 'coqui') continue;
    if (pcmDurationSec(r.pcm.length, r.sampleRate) < MIN_DURATION_SEC) continue;
    const vec = await embedFn(r.pcm, r.sampleRate);
    rows.push({ characterId: group.characterId, sentenceIds: group.sentenceIds.slice(), vec });
    onEmbed?.();
  }
  return rows;
}

export interface SynthesiseChapterOpts {
  sentences: SentenceOutput[];
  cast: CastCharacter[];
  provider: TtsProvider;
  modelKey: TtsModelKey;
  /** The run's DEFAULT engine — used for any character that doesn't carry its
      own `ttsEngine`, and the engine `provider`/`modelKey` below speak. Must
      match the engine behind `provider`. */
  engine: TtsEngine;
  /** Per-character engine routing (plan 108). When provided, each group + the
      title beat resolve their character's engine via `resolveCharacterEngine`
      and look up that engine's provider + modelKey here; absent → every
      character uses the default `provider`/`modelKey`/`engine` (byte-identical
      to pre-108). The caller (generation.ts) builds + caches one provider per
      engine so a mixed-engine chapter never reconstructs providers per group. */
  resolveForEngine?: (engine: TtsEngine) => { provider: TtsProvider; modelKey: TtsModelKey };
  /** When true, the Qwen engine is unavailable for this run (not installed, or
      its load failed) — every Qwen-routed character falls back to Kokoro
      instead of hard-failing, exactly as an undesigned-voice character does.
      Requires `resolveForEngine` (to obtain the Kokoro provider). Default
      false. */
  qwenUnavailable?: boolean;
  /** fs-2 — when true, the Qwen→Kokoro graceful fallback is FORBIDDEN: a
      Qwen-routed character with no designed voice (or an unavailable Qwen
      engine) throws `MissingDesignedVoiceError` instead of rendering in
      Kokoro. Set by generation.ts for non-English books, where a Kokoro
      fallback would read the book's language through an English-only voice
      (cross-language garbage). Default false (English books keep the
      graceful fallback, byte-identical to pre-fs-2). */
  forbidKokoroFallback?: boolean;
  /** fs-60 — when true, a Qwen-routed character that needs the Kokoro
      fallback (blocked by forbidKokoroFallback) falls back to Coqui instead
      of throwing MissingDesignedVoiceError. Set by the three server routes
      from `resolveEligibleEngines(bookLanguage, ...).includes('coqui')`.
      Requires `resolveForEngine` (to obtain the Coqui provider). Default
      false — a still-unsupported non-English language keeps today's
      fail-loud behavior unchanged. */
  coquiEligible?: boolean;
  /** fs-2 — the book's BCP-47 language, used only to phrase
      `MissingDesignedVoiceError`. Optional; defaults to a generic message. */
  bookLanguage?: string;
  /** Notification fired *before* each group's TTS call starts. Needed because
      a single group can be a multi-minute call on CPU (e.g. a long narrator
      block folded into one synth), and without a tick at the start the SSE
      goes silent and the UI's 30s "Worker has gone quiet" banner fires for
      what is actually healthy in-progress work. Letting the route handler
      emit a "synthesising group N" tick here resets the client-side stall
      timer at each group boundary.

      `completed` is the count of groups finished so far at fire time (a single
      monotonic counter shared by every in-flight worker). The route reports the
      "line N of M" / progress bar from THIS, not from `group.index` — under
      parallel dispatch (poolWidth > 1) + Qwen batching, group.index is the
      position of whichever item happens to tick last and bounces backward; the
      shared completed count never regresses. See plan 107 / 113. */
  onGroupStart?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
    completed: number;
  }) => void;
  /** Notification on each group completion. Optional. `completed` is the
      post-increment count of finished groups (monotonic) — see `onGroupStart`. */
  onGroupComplete?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
    completed: number;
  }) => void;
  /** Notification fired before each auto-retry sleep when the provider
      throws a transient error. `attempt` is the 1-indexed attempt
      number that's about to start (so the first retry passes attempt=2).
      The route handler can wire this to the SSE stream to surface a
      "retrying group N (attempt 2/3) — sidecar 503" hint while the
      auto-retry runs; persistent failures still throw out of
      `synthesiseChapter` exactly as before. */
  onGroupRetry?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    attempt: number;
    backoffMs: number;
    reason: string;
  }) => void;
  /** Notification on each completed Qwen BATCH (plan 127 live RTF). `genMs` is
      the sidecar's forward-compute wall for the batch and `audioMs` the audio
      it produced, so the caller can record a per-batch RTF (genMs ÷ audioMs)
      and surface a live throughput readout — far more responsive than the
      per-chapter rollup. Only fires when the sidecar reported the perf fields;
      single-group (non-batched) work does not fire it. */
  onBatchComplete?: (e: { batchSize: number; genMs: number; audioMs: number }) => void;
  /** Fired after each render-integrity embed completes during the post-synth
      SPK pass. The route wires it to the no-progress watchdog so a long
      CPU-bound embed pass keeps the chapter alive (sibling of #1029). */
  onEmbedProgress?: () => void;
  /** #1813 — fired by the cloned/designed voice resolver pre-pass
      (clone-voice-resolver.ts) immediately before it starts re-deriving a
      Repairable cloned voice, or self-healing a missing/stale designed
      voice `.pt` — both a real, multi-second sidecar clone-distil round
      trip that ran with NO UI signal before this (known-limitation KL-f):
      `reportProgress` was wired `undefined` in both `buildDefault*Deps`
      below because no typed channel existed. Threaded into
      `buildDefaultCloneResolverDeps`/`buildDefaultDesignedResolverDeps` as
      `onVoicePrepare`, and re-fired on the `groupHeartbeatMs` cadence
      (`withVoicePrepareHeartbeat` below) while a derive is in flight, the
      same "stall detector" concern `onGroupStart`'s heartbeat exists for. */
  onVoicePrepare?: (e: { characterId: string; characterName: string }) => void;
  /** Optional abort signal — checked between groups and forwarded to the
      provider so an in-flight TTS call can be cancelled mid-call. Used by
      the per-bookId server mutex to stop a stale generation handler when a
      new POST arrives for the same book. */
  signal?: AbortSignal;
  /** Pre-built spoken phrase for the chapter title (e.g. `"Chapter 2.
      Moolark."`). Built by `buildChapterTitleNarration` in
      `chapter-title-narration.ts` from `chapter.id` + parsed `chapter.title`.
      When non-empty, the synth loop prepends
      `[CHAPTER_LEAD_SILENCE_SEC of silence] + [narrator voicing this string]
      + [CHAPTER_POST_TITLE_SILENCE_SEC of silence]` ahead of the body
      sentences. The title's TTS response anchors the chapter's sample rate
      (same rule the first body group used before this feature). Undefined or
      blank skips the title beat AND the silence padding — legacy behaviour
      for callers that don't opt in. */
  chapterTitleNarration?: string;
  /** Cast id used to look up the voice for the chapter-title narration.
      Defaults to `'narrator'`, the special-cased narrator character
      (`src/views/listen.tsx:139`). The picker falls through to a
      narrator-voice bucket when the character has no gender / age / tone
      hints, which is the correct routing for the title regardless of
      whether the cast actually contains a `'narrator'` row.

      fs-38 Wave 3c, Task 23 — this id is a HINT, not gospel: if the cast has
      no row under this exact id but DOES carry one under the other
      recognised narrator id (`'narrator'`/`'char-narrator'` — the same pair
      `voice-mapping.ts`'s `inferProfile` treats as narrator), the real row
      is used instead. Every route today passes the literal `'narrator'`
      unconditionally, so a book whose narrator row is `'char-narrator'`
      needs this re-resolution to ever reach its real overrides — see
      the resolution right after `castById` is built. */
  narratorCharacterId?: string;
  /** Tick BEFORE the chapter-title TTS call begins. Lets the SSE route emit
      a "Synthesising chapter title…" hint so the client's stall detector
      doesn't fire while the (potentially multi-second) title synth runs.
      Mirrors `onGroupStart` for body groups. */
  onTitleStart?: () => void;
  /** Tick AFTER the chapter-title TTS call completes. The accumulated
      duration is the audio time at the end of the title segment (i.e. the
      moment the post-title silence begins). */
  onTitleComplete?: (e: { accumulatedSec: number }) => void;
  /** How many sentence groups to *attempt* concurrently (plan 107). Defaults
      to `DEFAULT_SENTENCE_CONCURRENCY` (1) — see that constant's comment for
      why this is the flag-OFF safety invariant, not a tunable production
      knob. An explicit value is mainly for tests, which need to exercise
      width>1 without touching process env. Clamped to >= 1. */
  sentenceConcurrency?: number;
  /** Heartbeat cadence for the GPU-FIFO false-stall guard (queue-sole). The
      GPU token is acquired INSIDE `provider.synthesize`
      (`server/src/tts/sidecar.ts`), so a group blocked in the semaphore FIFO
      behind a sibling chapter emits its `onGroupStart` tick, then goes silent
      until the token is granted — which can exceed the client's 30 s "Worker
      has gone quiet" watchdog (`STALL_THRESHOLD_MS`). To keep `lastTickAt`
      fresh while a group waits, we re-fire `onGroupStart` on this interval
      from the moment the group is dispatched until its `synthesize` resolves.
      Reuses the existing tick plumbing (no new tick type / SSE shape).
      Defaults to 10 s (well under the 30 s threshold). Set to 0 / a
      non-positive value to disable (tests that assert exact onGroupStart
      counts). Clamped pure — never reads process.env. */
  groupHeartbeatMs?: number;
  /** Defensive per-call timeout in ms (plan 148). Bounds a single provider
      synth/batch call so a runaway/never-returning call fails the chapter
      instead of hanging the queue. Defaults to `SYNTH_CALL_TIMEOUT_MS`
      (env `SIDECAR_CALL_TIMEOUT_MS`, default 600 000). `<= 0` disables.
      An explicit small value lets tests drive the timeout deterministically.
      Since #1893 it ALSO bounds the mixed-phase Qwen `/unload` — not a synth
      call, and one whose timeout is caught and warned rather than failing
      the chapter (see `synthGroupsSerialized`). `<= 0` re-opens the
      unbounded wait there. */
  callTimeoutMs?: number;
  /** How many Qwen sentences to pack per batched synth call (plan 112).
      Defaults to the module-level `QWEN_BATCH_SIZE` (env `QWEN_BATCH_SIZE`,
      default 32). `=1` disables batching (every Qwen sentence is its own
      call). Mainly an explicit value for tests, which exercise packing /
      splitting without touching process env. Clamped to >= 1. Only Qwen
      sentences are ever batched — see the dispatch partition below. */
  qwenBatchSize?: number;
  /** Hard width cap for the 1.7B Quality tier specifically (8 GB OOM guard).
      The 1.7B-Base is ~3.4 GB resident, so a 1.7B batch as wide as the 0.6B
      default OOMs an 8 GB card mid-forward → recycle storm. The packer applies
      this to the 1.7B bucket only; 0.6B groups keep `qwenBatchSize`. Defaults to
      the module-level `QWEN_BATCH_SIZE_17B` (env `QWEN_BATCH_SIZE_17B`, default
      8). Clamped to >= 1. */
  qwenBatchSize17b?: number;
  /** Token-budget for the 1.7B tier only (env `QWEN_BATCH_TOKEN_BUDGET_17B`,
      default 1200 — far below the 0.6B `qwenBatchTokenBudget`). Keeps 1.7B
      batches within an 8 GB card; `0` = exact fixed-width slicing on the 1.7B
      tier (`qwenBatchSize17b` only). 0.6B groups keep `qwenBatchTokenBudget`. */
  qwenBatchTokenBudget17b?: number;
  /** Length-bucketing (plan 128): sort batchable Qwen groups by their
      normalised text length before slicing into batches, so similar-length
      sentences share a batch and the batched forward decodes to a tight
      max-length (less padding waste). Defaults to `QWEN_BATCH_BUCKET` (env
      `QWEN_BATCH_BUCKET`, default ON). Output-preserving — set `false` for the
      index-order baseline (tests assert byte-identity ON vs OFF). */
  qwenBatchBucket?: boolean;
  /** Token-budget packing (plan 136). The soft VRAM/compute budget in
      normalised-text chars; the packer fills each batch while
      `(count+1) × candidateMaxLen <= qwenBatchTokenBudget` AND
      `count+1 <= qwenBatchSize` (the hard width cap). Defaults to the
      module-level `QWEN_BATCH_TOKEN_BUDGET` (env, default 3600). An explicit
      `0` falls back to EXACT fixed-width slicing — the kill-switch and the
      back-compat contract. Relies on `qwenBatchBucket` (the ascending length
      sort) being on, which it is by default; with bucketing off the packer
      still runs but tracks a per-batch running max so the proxy stays a true
      upper bound. Mainly an explicit value for tests, which drive packing
      without touching process env. */
  qwenBatchTokenBudget?: number;
  /** Pre-assembly per-sentence QA gate (segment-qa.ts). After all body groups
      synthesise but BEFORE the chapter is concatenated, each group's PCM is
      checked for dead/near-silence, a long internal silence run, and duration
      drift; a `suspect` group is re-recorded in place via `synthGroup` up to
      this many times, keeping the best take. `0` (the default) disables the
      gate entirely — byte-identical to pre-gate behaviour, the kill-switch.
      generation.ts sets the production default (env `SEG_QA_MAX_RERECORDS`). */
  maxSegmentRerecords?: number;
  /** Explicit thresholds for the QA gate (mainly for tests). Absent → the gate
      reads its env/default thresholds per call (see `segment-qa.ts`). */
  segmentQaThresholds?: SegmentQaThresholds;
  /** Fired before each gate re-record so the SSE route can surface
      "re-recording sentence N (attempt K)" instead of a silent stall.
      `reasons` is the failing verdict's reason list. */
  onSegmentRerecord?: (e: {
    group: SentenceGroup;
    attempt: number;
    maxRerecords: number;
    reasons: string[];
  }) => void;
  /** ASR content-QA pass (srv-31). Absent → no ASR (byte-identical to today).
      When provided, after the signal-QA loop each sampled body group's audio is
      transcribed and word-error-rated against its sentence text; a `drift`
      verdict is re-recorded up to `maxRerecords`, best-of-N by WER. The pass is
      inline here, but the multi-worker queue overlaps chapter N's (CPU) ASR with
      chapter N+1's (GPU) synth, so it doesn't serialise the run. */
  asr?: AsrPassOptions;
  /** C1 (Wave 3) — recover from a transient sidecar-down WITHOUT discarding
      completed groups. When a synth site throws a recoverable error
      (`isTransient` OR a `ChapterSynthTimeoutError`), the site calls this hook
      to wait out the respawn, then re-attempts the SAME work item; every
      already-completed `results[]` slot is preserved. Wired by generation.ts to
      `ensureSidecarEngineReady(engine, signal)` (+ the C2 recovering tick).
      `engine` is the failed item's resolved engine (a chapter can be mixed-
      engine); `attempt` is the 1-indexed shared recovery count. ABSENT → no
      in-loop recovery: a transient bubbles out unchanged (pre-C1 behaviour, the
      passthrough every existing caller/test relies on). */
  onRecoverRecycle?: (e: { engine: TtsEngine; attempt: number }) => Promise<void>;
  /** Max in-loop recycle recoveries SHARED across all groups/workers of this
      chapter. Mirrors generation.ts `MAX_RECYCLE_RECOVERIES` (2). Exceeding it
      throws `RecycleStormError` so the chapter fails fast (no infinite grind).
      Only consulted when `onRecoverRecycle` is provided. Default 2. */
  maxRecycleRecoveries?: number;
  /** fs-38 Wave 3b2 — override some/all of the cloned-voice resolver
      pre-pass's dependencies (readEntry/writeEntry/ptExists/deriveEngineArtifact/
      readMasterPcm/currentBaseModel) instead of the real workspace + sidecar
      wiring. Mainly for tests, which need to exercise the pre-pass (readiness
      gate, fail-fast, repair) without touching the real voice-library disk.
      Absent → the real `workspace/voice-library.js` + `derive-engine-artifact.js`
      + `mp3.js` wiring (production behaviour). Merged shallowly over the real
      deps, so a test can override just one function. */
  cloneResolverDepsOverride?: Partial<ResolveChapterDeps>;
  /** fs-38 Wave 3b2, Task 12 (§2.3) — override some/all of the DESIGNED-voice
      self-heal pre-pass's dependencies (ptExists/readDesignedMasterPcm/
      deriveEngineArtifact), mirroring `cloneResolverDepsOverride` above.
      Absent → the real sidecar-disk wiring (production behaviour). Merged
      shallowly over the real deps, so a test can override just one function. */
  designedResolverDepsOverride?: Partial<ResolveDesignedVoiceDeps>;
}

/** Options for the per-sentence ASR content-QA pass (srv-31). */
export interface AsrPassOptions {
  /** Max re-records of a `drift` segment (best-of-N by WER). `0` = detect + flag
      only (no re-record). generation.ts resolves this from SEG_ASR_MAX_RERECORDS. */
  maxRerecords?: number;
  /** Transcribe 1-in-N body groups (stride). `1` (default) = every sentence. */
  sampleEvery?: number;
  /** Whisper language hint — non-English books MUST set this or the WER is noise. */
  language?: string | null;
  /** Per-book proper-noun allowlist (cast names) so invented names don't drift. */
  nameAllowlist?: Iterable<string>;
  /** Explicit WER thresholds (mainly tests); absent → env/defaults per call. */
  thresholds?: Partial<AsrThresholds>;
  /** Inject a transcribe fn (tests); absent → the real sidecar client. */
  transcribeFn?: (
    pcm: Buffer,
    sampleRate: number,
    o: { language?: string | null; signal?: AbortSignal; sidecarUrl?: string },
  ) => Promise<TranscribeResult>;
  /** Sidecar URL override (tests). */
  sidecarUrl?: string;
  /** Fired before each ASR re-record so the SSE route can surface it. */
  onRerecord?: (e: {
    group: SentenceGroup;
    attempt: number;
    maxRerecords: number;
    wer: number;
    reasons: string[];
  }) => void;
  /** Fired at the START of each sampled group's ASR check — including `ok`
      verdicts — so the SSE route can surface a "verifying" phase and keep the
      no-progress watchdog fed through a drift-free pass (a clean chapter fires
      no `onRerecord` at all). `verified` is the 0-based index of this group
      among the sampled groups; `total` is how many groups will be checked. */
  onProgress?: (e: { verified: number; total: number }) => void;
}

/** One group per sentence. Plan 70d — earlier code folded consecutive
    same-speaker sentences into one synth call to cut HTTP roundtrips.
    Two production failures pushed us to per-sentence:
      1. A 207-sentence narrator block on the canonical The Hollow Tide book
         folded into one Kokoro call that ran longer than the 30 s
         "Worker has gone quiet" client watchdog, then either timed out
         on the model side or hung at very large context sizes — never
         emitting a chapter_complete.
      2. Voice drift inside a long same-speaker group as Kokoro / XTTS
         context-position pressure shifts prosody mid-chunk.
    Per-sentence also gives the SSE stream a progress tick per sentence
    so the UI's "line N of M" caption advances continuously instead of
    sitting on `1 of 207` for the whole call.
    Order preserved. */
export function buildSentenceGroups(sentences: SentenceOutput[]): SentenceGroup[] {
  /* Drop any sentence whose spoken text is empty after normalisation. Such a
     sentence would otherwise become a synth item with empty `text`, which the
     sidecar rejects with `400 "item N: text is required"` — failing the WHOLE
     chapter (the 2026-05-31 ch14 failure: a blank/whitespace sentence reached
     the batch). Filter with the SAME `normaliseForTts` the synth path applies
     (:708/:750) so the guard matches exactly what would be sent. `index` is
     re-sequenced over the KEPT groups because it's the scatter-back slot key
     for the index-order concat (`results[group.index]`); a gap would leave a
     hole in the concatenated PCM. A dropped sentence has no spoken audio, so it
     correctly contributes no segment. */
  return sentences
    .filter((s) => !s.excludeFromSynthesis) // fs-58 Unit B — flag_nonstory
    .filter((s) => normaliseForTts(s.text).trim() !== '')
    .map((s, i) => ({
      index: i,
      characterId: s.characterId,
      sentenceIds: [s.id],
      text: s.text,
      emotion: s.emotion,
      /* fs-57 — carry through only when present (additive, back-compat). */
      ...(s.instruct != null ? { instruct: s.instruct } : {}),
      ...(s.vocalization != null ? { vocalization: s.vocalization } : {}),
    }));
}

/** Build the VoiceLike payload that pickVoiceForEngine consumes from a
    confirmed-cast Character. Uses voiceId when present so the same character
    in the library stays on the same prebuilt voice; falls back to characterId.

    Passes BOTH the new per-engine map and the legacy singular field; the
    picker prefers the map when present and the synth engine matches a
    slot. The legacy field is only consulted as a fallback for cast.json
    files that haven't yet round-tripped through the normaliser. */
export function toVoiceLike(c: CastCharacter): VoiceLike {
  return {
    id: c.voiceId ?? c.id,
    character: c.name,
    attributes: c.attributes ?? [],
    overrideTtsVoices: c.overrideTtsVoices ?? null,
    overrideTtsVoice: c.overrideTtsVoice ?? null,
    voiceUuid: c.voiceUuid,
  };
}

/** Project the cast.json shape onto the CharacterHint the voice picker wants.
    Without this, `inferGender` falls back to the description/attribute scan
    and almost always returns 'unknown' (the analyzer's attributes are
    personality traits, not gendered nouns), which routes every character to
    narrator-cool. */
export function buildHintFromCast(c: CastCharacter): CharacterHint {
  const evidence = (c.evidence ?? [])
    .map((e) => (typeof e === 'string' ? e : e?.quote))
    .filter((q): q is string => typeof q === 'string' && q.length > 0);
  return {
    description: c.description,
    role: c.role,
    gender: c.gender,
    ageRange: c.ageRange,
    tone: c.tone,
    evidence: evidence.length ? evidence : undefined,
  };
}

/* fs-60 — Qwen and Coqui are both VRAM-heavy engines whose real footprints
   can co-exceed an 8 GB card even though a naive per-engine VRAM budget
   check would admit them together (see the design spec §4). Rather than
   retuning such a shared budget table (a separate, riskier change affecting
   every existing Qwen-concurrency decision), a mixed Qwen+Coqui chapter is
   partitioned into two serial phases with an explicit evict between them.
   No longer holds a full-budget gpuSemaphore lock during the unload —
   same-engine/cross-book serialization against a concurrent synth call from
   another book now lives in the sidecar (`_synth_lock` + the sidecar load
   locks), not a Node-side mutex. This does NOT check activeGenerationBooks/
   refuse when a render is active: it's deliberately called *during* an active
   render, as part of this chapter's own sequencing. */
/* fs-38 Wave 3c, Task 22 fix round 1 (F5) — shared implementation. Task 15
   was rejected on this branch for re-deriving shared vocabulary locally
   (`manifestSlotFor`); the same standard applies here — the mirror pair
   below is warranted (two distinct, named call sites read better than one
   parameterised call at each site), but the fetch/error-message body is
   not, so a future timeout or error-message change lands in one place.

   The `signal` parameter is #1893's, kept through Wave 3c's generalisation:
   this `/unload` takes the sidecar's `_synth_lock`, so it can legitimately
   queue behind ANOTHER book's in-flight synth. Without a signal it was
   uncancellable and could stall a chapter forever. Every call site must
   forward the chapter's signal AND bound the call — see the callers. */
async function evictEngineForPhase(engine: CloneEngine, signal?: AbortSignal): Promise<void> {
  const url = getResolvedSidecarUrl();
  const res = await fetch(`${url}/unload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`Sidecar /unload returned ${res.status} ${res.statusText}`);
  }
}

async function evictQwenForCoquiPhase(signal?: AbortSignal): Promise<void> {
  return evictEngineForPhase('qwen', signal);
}

/* fs-38 Wave 3c, Task 22 [FAB-I2] — the mirror of `evictQwenForCoquiPhase`
   above: evicts Coqui so a subsequent Qwen derive/render doesn't run with
   XTTS (~3.5 GB) still resident, the same co-residency hazard mirrored the
   other direction. Used ONLY by the cloned/designed-voice resolver pre-pass
   (below) to hand off from "coqui derive phase" back to "qwen phase" — see
   the pre-pass's own Task 22 comment for why this fires only when a qwen
   load is about to happen afterward (evicting XTTS unconditionally would
   unload it right before every Coqui-only chapter's groups reload it). */
async function evictCoquiForQwenPhase(signal?: AbortSignal): Promise<void> {
  return evictEngineForPhase('coqui', signal);
}

/* fs-38 Wave 3b2 — read a cloned voice's retained reference clip (its
   `master.wav`, kept since the Wave 3a ingest) and decode it to raw s16le PCM
   at its own recorded sample rate, ready for `deriveEngineArtifact`. The
   resolver only calls this on a `repairable` classification, which (per
   `classifyClonedVoice`) is never reached unless `entry.master` is present —
   but a caller invoking this directly should still get a clear error rather
   than a `TypeError` on an absent `master`. */
async function readMasterPcmDefault(
  uuid: string,
  entry: VoiceLibraryEntry,
): Promise<{ pcm: Buffer; sampleRate: number; refText: string }> {
  if (!entry.master) {
    throw new Error(`Cloned voice "${uuid}" has no retained master clip to re-derive from.`);
  }
  /* MINOR-3 — sanitize the clip filename the same way every other path
     builder in this file's neighbourhood does (qwenVoicePtPath et al.):
     `entry.master.clipFile` is manifest data, not a hardcoded literal, so it
     gets the same throwing safeSegment() pre-filter + sanitizeIdSegment()
     CodeQL-recognized transform + assertContained() containment check
     before it's joined onto disk. */
  const dir = entryDir(uuid);
  const clipPath = join(dir, sanitizeIdSegment(safeSegment(entry.master.clipFile)));
  assertContained(dir, clipPath);
  const raw = await readFile(clipPath);
  const pcm = await decodeAudioToPcm(raw, entry.master.sampleRate);
  return { pcm, sampleRate: entry.master.sampleRate, refText: entry.master.transcript };
}

/* fix wave (Task 18 review, CRITICAL-1) — the coqui artifact lives under
   `xttsVoicesDir()`, a different directory from `qwenVoicesDir()`
   (workspace/paths.js), so a storage key of `xtts-<uuid>` must resolve
   through `xttsVoiceLatentsPath`, not `qwenVoicePtPath` — stat()-ing the
   wrong directory always misses, which reads as "missing" and drives every
   healthy coqui-cloned voice through a full GPU derive on every chapter.
   Dispatched on the storage key's prefix (derived from `manifestSlotFor`,
   never hand-built — Task 15's local `manifestSlotFor` copy was rejected for
   exactly this reason) rather than threading `engine` through the
   `ResolveChapterDeps.ptExists(storageKey)` signature, since this same
   function also backs the designed-voice resolver's qwen-only `ptExists`. */
const COQUI_STORAGE_KEY_PREFIX = `${manifestSlotFor('coqui')}-`; // 'xtts-'

/** Shared by both the cloned- and designed-voice resolver deps builders — a
    real stat() of the cached artifact under the given storage key, resolved
    to the right per-engine directory (see the comment above). */
// fix wave (Task 18 review, CRITICAL-1) — exported so a real-deps test can
// exercise the per-engine path resolution directly (writing a fixture file
// at the REAL `xttsVoiceLatentsPath`/`qwenVoicePtPath` locations) rather than
// only indirectly through `synthesiseChapter`, whose sole production call
// site still hardcodes `engine: 'qwen'` (Task 20 lifts that literal) and so
// cannot reach the coqui branch of this function today.
export async function defaultPtExists(storageKey: string): Promise<boolean> {
  const path = storageKey.startsWith(COQUI_STORAGE_KEY_PREFIX)
    ? xttsVoiceLatentsPath(storageKey)
    : qwenVoicePtPath(storageKey);
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/* fs-38 Wave 3c, Task 14 — `cloneResolverDepsOverride`/
   `designedResolverDepsOverride` are documented as a SHALLOW merge over the
   real deps ("a test can replace just the pieces it needs to fake").
   `updateEntry` is a NEW primitive that performs its OWN internal
   readEntry+writeEntry — so a test overriding `readEntry`/`writeEntry` (to
   fake the voice-library store) but not `updateEntry` would, under a bare
   shallow merge, silently keep the REAL `updateEntry` from
   `buildDefault*ResolverDeps`, which reads/writes the REAL on-disk
   workspace and ignores the test's fakes entirely — reporting the test's
   requested voice as missing rather than whatever the fake `readEntry`
   intended. Recompose `updateEntry` from the FINAL `readEntry`/`writeEntry`
   whenever either was overridden and `updateEntry` itself wasn't,
   preserving the "just the pieces it needs" contract for this primitive
   too. A no-op (returns `merged` unchanged) whenever the caller supplied
   its own `updateEntry` override or overrode neither read nor write. */
function withDerivedUpdateEntry<
  T extends {
    readEntry(uuid: string): Promise<VoiceLibraryEntry | null>;
    writeEntry(entry: VoiceLibraryEntry): Promise<void>;
    updateEntry(
      uuid: string,
      mutate: (
        entry: VoiceLibraryEntry | null,
      ) => Promise<VoiceLibraryEntry | null | undefined> | VoiceLibraryEntry | null | undefined,
    ): Promise<VoiceLibraryEntry | null>;
  },
>(merged: T, override: Partial<T> | undefined): T {
  if (!override || override.updateEntry || (!override.readEntry && !override.writeEntry)) {
    return merged;
  }
  const { readEntry: mergedReadEntry, writeEntry: mergedWriteEntry } = merged;
  return {
    ...merged,
    updateEntry: async (uuid, mutate) => {
      const fresh = await mergedReadEntry(uuid);
      const next = await mutate(fresh);
      if (!next) return null;
      await mergedWriteEntry(next);
      // Fix wave (review I-1) — mirrors production's `updateEntry`
      // fallback (workspace/voice-library.ts): null must mean ONLY
      // "mutate declined", never "the canonical re-read merely failed" —
      // e.g. a fixed-value `readEntry` mock that can't observe its own
      // fake write (M-3). Falling back to `next` keeps this recomposed
      // primitive's contract identical to the real one.
      return (await mergedReadEntry(uuid)) ?? next;
    },
  };
}

/* fs-38 Wave 3b2 — the resolver pre-pass's real (production) dependency
   wiring: the actual voice-library manifest store, the actual sidecar
   clone-derive call, and a real stat() of the cached `.pt`. `synthesiseChapter`
   merges `opts.cloneResolverDepsOverride` shallowly over this so a test can
   replace just the pieces it needs to fake (see that opt's doc comment). */
/* Exported (previously module-private) so fs-38 Wave 3c Task 19's
   currentArtifactVersion wiring can be driven directly — no production or
   test call site routes a cloned voice through the 'coqui' engine via
   synthesiseChapter yet (the sole caller still hardcodes `engine: 'qwen'`
   per-request; generalising that is Task 20's job), so nothing else
   exercises this function's coqui arm. Mirrors defaultPtExists's own
   Task-18-fix-wave export for the identical reason. */
export function buildDefaultCloneResolverDeps(
  signal: AbortSignal | undefined,
  onVoicePrepare?: (e: { characterId: string; characterName: string }) => void,
): ResolveChapterDeps {
  return {
    readEntry,
    writeEntry,
    updateEntry,
    ptExists: defaultPtExists,
    deriveEngineArtifact,
    readMasterPcm: readMasterPcmDefault,
    /* fs-38 Wave 3c, Task 18 — qwen keeps its existing oracle
       (`currentQwenBaseModel()`, an env-configured Node-side constant).
       Task 19 gives Coqui its own oracle: `getLastKnownCoquiVersion()`,
       fed by the sidecar's /health poll (routes/sidecar-health.ts) via
       `main.py`'s `_coqui_installed_version()` — the installed coqui-tts
       PACKAGE version isn't a Node-side constant like Qwen's; it can only be
       observed from the running sidecar process. Before the first reachable
       poll (the boot window) it reads '' — the SAME structural no-op Task 18
       shipped: `isArtifactVersionStale` (clone-engines.ts) treats an unknown
       CURRENT version as "not stale", so a cold-started server never forces
       a spurious re-derive of every cloned coqui voice on its first chapter.
       See clone-voice-resolver.ts's ClassifyInput doc comment for the full
       reasoning. */
    currentArtifactVersion: (engine) =>
      engine === 'coqui' ? getLastKnownCoquiVersion() : currentQwenBaseModel(),
    purgeCloneArtifacts,
    /* #1813 — retires the old `reportProgress: undefined` placeholder: see
       `SynthesiseChapterOpts.onVoicePrepare`'s doc comment for the chain. */
    onVoicePrepare,
    signal,
  };
}

/* fs-38 Wave 3b2, Task 12 (§2.3) — the fixed decode rate for a DESIGNED
   voice's retained reference clip. Mirrors clone-ingest.ts's own SAMPLE_RATE
   constant (24 kHz) for a cloned voice's captured clip: the on-disk wav is a
   proper self-describing RIFF file (Python's `wave` module wrote it), so
   `decodeAudioToPcm` resamples to whatever target we ask for regardless of
   the source rate — this just picks the SAME target the rest of the codebase
   already treats as this pipeline's canonical PCM rate, so the reported
   `X-Sample-Rate` is exactly the rate of the bytes actually sent. */
const DESIGNED_MASTER_SAMPLE_RATE = 24_000;

/* fs-38 Wave 3b2, Task 12 (§2.3) — read a DESIGNED voice's retained reference
   clip (`qwen-<uuid>__master.wav`, written by the sidecar's design_voice
   since Task 11) plus the matching ref_text off that SAME design's sidecar
   manifest (`qwen-<uuid>.json`'s `refText` field is the exact calibration
   text `design_voice` used to produce the retained clip — see main.py ~3838).
   Both files are sidecar-local (workspace/paths.js), NOT the
   workspace/voice-library.ts entry-dir `master` a CLONED voice's ingested
   clip lives in — a designed voice never populates that field. Returns
   `null` (never throws) when either artifact is missing/unreadable, so the
   caller falls through to today's behaviour instead of a new failure mode.

   Also returns the FULL parsed manifest (review C-1): the sidecar's
   `clone_voice` handler truncate-rewrites `qwen-<uuid>.json` to a bare clone
   shape on a successful re-derive, dropping `instruct`/`designModel`/
   `mintMethod`/`fallbackFor` entirely — the caller needs this PRE-derive
   snapshot to restore those fields afterwards. */
/* fs-38 Wave 3c, Task 20a [DELTA-M1] — `engine` gates whether an empty
   `refText` disqualifies the read. A QWEN derive needs a transcript
   (`deriveEngineArtifact` validates `refText` at call time for `engine ===
   'qwen'`); a COQUI derive is purely acoustic and never sends `refText` on
   the wire at all, so gating a coqui self-heal on `refText` presence would
   misreport "no retained clip" for a design whose manifest merely lacks
   one — the master.wav clip itself is still perfectly usable. The storage
   key stays hardcoded to the `qwen-` prefix regardless of `engine`: the
   retained clip is a property of the DESIGN (minted once, only ever via
   qwen VoiceDesign), not of whichever engine later derives an artifact
   from it. */
async function readDesignedMasterPcmDefault(
  uuid: string,
  engine: CloneEngine,
): Promise<
  { pcm: Buffer; sampleRate: number; refText: string; manifest: Record<string, unknown> } | null
> {
  const storageKey = `qwen-${uuid}`;
  /* I-1 (review) — the whole body now lives in ONE try/catch. Previously
     `decodeAudioToPcm` sat outside every try here, so a corrupt/undecodable
     retained clip (ffmpeg spawn failure or non-zero exit — mp3.ts ~523-535)
     threw straight out of this "never throws" function, up through the
     caller's unguarded await, and aborted a chapter that would otherwise
     have rendered fine. */
  try {
    const manifest = await readJson<Record<string, unknown>>(qwenVoiceSidecarPath(storageKey));
    if (!manifest) return null;
    const refText = typeof manifest?.refText === 'string' ? (manifest.refText as string).trim() : '';
    if (engine === 'qwen' && !refText) return null;
    const raw = await readFile(qwenVoiceWavPath(`${storageKey}__master`));
    const pcm = await decodeAudioToPcm(raw, DESIGNED_MASTER_SAMPLE_RATE);
    return { pcm, sampleRate: DESIGNED_MASTER_SAMPLE_RATE, refText, manifest };
  } catch {
    return null;
  }
}

/* fs-38 Wave 3b2, Task 12 (§2.3), review C-1 — atomically re-write a designed
   voice's sidecar manifest (`qwen-<uuid>.json`) after a successful self-heal
   derive, restoring the designed-only fields the sidecar's `clone_voice`
   handler otherwise truncates away. Mirrors the atomic-write convention used
   for every other JSON manifest in this codebase (state-io.ts). */
async function writeSidecarManifestDefault(
  uuid: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  await writeJsonAtomic(qwenVoiceSidecarPath(`qwen-${uuid}`), manifest);
}

/* fs-38 Wave 3b2, Task 12 (§2.3) — the designed-voice self-heal pre-pass's
   real (production) dependency wiring, mirroring
   `buildDefaultCloneResolverDeps` above. */
function buildDefaultDesignedResolverDeps(
  signal: AbortSignal | undefined,
  onVoicePrepare?: (e: { characterId: string; characterName: string }) => void,
): ResolveDesignedVoiceDeps {
  return {
    ptExists: defaultPtExists,
    readDesignedMasterPcm: readDesignedMasterPcmDefault,
    writeSidecarManifest: writeSidecarManifestDefault,
    /* #1951 — the manifest restore above is only effective if the sidecar's
       warm prompt cache is dropped too; see the dep's doc comment. The route
       is keyed by the qwen STORAGE KEY, not the bare uuid. */
    evictSidecarVoice: (uuid) => evictSidecarVoice('qwen', cloneStorageKey('qwen', uuid)),
    readEntry,
    writeEntry,
    updateEntry,
    deriveEngineArtifact,
    /* fs-38 Wave 3c, Task 20a — coqui arm only (DELTA-I3 staleness check);
       identical wiring to buildDefaultCloneResolverDeps's own
       currentArtifactVersion above, so the two resolvers can never
       independently drift on what "current" means per engine. */
    currentArtifactVersion: (engine) =>
      engine === 'coqui' ? getLastKnownCoquiVersion() : currentQwenBaseModel(),
    /* #1813 — retires the old `reportProgress: undefined` placeholder: see
       `SynthesiseChapterOpts.onVoicePrepare`'s doc comment for the chain. */
    onVoicePrepare,
    signal,
  };
}

export async function synthesiseChapter(
  opts: SynthesiseChapterOpts,
): Promise<ChapterSynthesisResult> {
  const {
    sentences,
    cast,
    provider,
    modelKey,
    engine,
    resolveForEngine,
    qwenUnavailable = false,
    forbidKokoroFallback = false,
    coquiEligible = false,
    bookLanguage,
    onGroupStart,
    onGroupComplete,
    onGroupRetry,
    onBatchComplete,
    onEmbedProgress,
    onVoicePrepare,
    signal,
    chapterTitleNarration,
    narratorCharacterId = 'narrator',
    onTitleStart,
    onTitleComplete,
    sentenceConcurrency = DEFAULT_SENTENCE_CONCURRENCY,
    groupHeartbeatMs = 10_000,
    callTimeoutMs = SYNTH_CALL_TIMEOUT_MS,
    qwenBatchSize = QWEN_BATCH_SIZE,
    qwenBatchSize17b = QWEN_BATCH_SIZE_17B,
    qwenBatchBucket = QWEN_BATCH_BUCKET,
    qwenBatchTokenBudget = QWEN_BATCH_TOKEN_BUDGET,
    qwenBatchTokenBudget17b = QWEN_BATCH_TOKEN_BUDGET_17B,
    maxSegmentRerecords = 0,
    segmentQaThresholds,
    onSegmentRerecord,
    asr,
    onRecoverRecycle,
    maxRecycleRecoveries = 2,
    cloneResolverDepsOverride,
    designedResolverDepsOverride,
  } = opts;

  /* fs-53: resolve the book language to a concrete BCP-47 primary subtag ONCE,
     then thread it into every audio-producing normaliseForTts call (title +
     group synth) AND every site compared against that audio (the batch-length
     key + the ASR-QA expected text) so spoken-form expansion stays aligned.
     `normaliseBookLanguage` defaults undefined/empty to 'en', so an English
     book (which often carries no explicit bookLanguage) still gets normalised —
     do NOT gate this on `bookLanguage` being truthy. `expandForSpeech`
     self-gates on supported+registered languages, so a dormant/unknown code is
     a pass-through. */
  const langCode = normaliseBookLanguage(bookLanguage);

  /* fs-56: per-character 1.7B Quality-tier — when the character carries a
     ttsModelKey and routes to Qwen, ELEVATE to it over the run default via
     `resolveCharacterQwenTier` (per-character-engine.js): the elevate-only rule
     means a stale/never-elevated character tier can never downgrade a run
     explicitly started at 1.7B (side-11 follow-up). That SAME helper stamps the
     per-character render tier into the snapshot (buildCharacterSnapshots) so the
     srv-36 audition renders on exactly this tier — the two can't drift. */

  /* Per-character engine resolver (plan 108). Returns the engine + its
     provider + modelKey for a given character. When the caller supplied
     `resolveForEngine`, each character routes to its own engine's provider;
     otherwise everything uses the run default — byte-identical to pre-108. */
  const routeFor = (
    c: CastCharacter,
  ): { engine: TtsEngine; provider: TtsProvider; modelKey: TtsModelKey } => {
    const charEngine = resolveCharacterEngine(c, engine);
    if (resolveForEngine && charEngine !== engine) {
      const r = resolveForEngine(charEngine);
      const charModelKey = charEngine === 'qwen' ? resolveCharacterQwenTier(c, r.modelKey) : r.modelKey;
      return { engine: charEngine, provider: r.provider, modelKey: charModelKey };
    }
    /* Same-engine path (character on the run-default engine but still
       carrying an explicit ttsModelKey for Qwen). */
    const charModelKey = charEngine === 'qwen' ? resolveCharacterQwenTier(c, modelKey) : modelKey;
    return { engine: charEngine, provider, modelKey: charModelKey };
  };

  type Route = { engine: TtsEngine; provider: TtsProvider; modelKey: TtsModelKey };

  /* Qwen → Kokoro graceful fallback. A Qwen route renders in Kokoro instead of
     hard-failing the chapter when the character has NO designed voice (empty
     voiceName) OR the Qwen engine is unavailable this run (`qwenUnavailable`).
     Reuses pickVoiceForEngine('kokoro', …) — same deterministic profile-voice
     inference every other Kokoro character gets — and reports the engine
     actually used so the segment can be stamped (UI "Fallback (Kokoro)").
     A no-op (returns the route unchanged) when the route isn't Qwen, the voice
     is designed + Qwen is available, or no Kokoro provider can be resolved. */
  const applyQwenFallback = (
    c: CastCharacter,
    route: Route,
    voiceName: string,
    detail?: string,
    /** #2023 Piece 2 — set to the sentence group's ORIGINAL characterId when
        this call is resolving an orphaned-characterId line (the group's own
        id has no cast entry and `c` is the substituted narrator instead).
        Gates the cloned-voice guard below: a cloned narrator must never
        speak another character's attributed line, even when that cloned
        voice is perfectly healthy — this is a misattribution risk, not an
        availability problem, so it's checked independently of `voiceName`/
        `routeEngineUnavailable`. */
    orphanedFromId?: string,
  ): { route: Route; voiceName: string; renderedFallbackEngine?: TtsEngine } => {
    /* C1 — a cloned voice is exempt from fallback/reroute on ANY clone-capable
       engine, not just Qwen (fs-38 Wave 3c, Task 21 — this guard used to be
       hardcoded to `route.engine === 'qwen'`, so a coqui-routed clone got NO
       exemption at all): if the character is cloned on its OWN routed engine
       and that engine can't actually carry it this run (no resolvable
       voiceName, OR the routed engine itself reads unavailable), raise
       instead of ever rerouting (never substitute a real person). A cloned
       voice with a healthy routed engine + a real voiceName falls through
       unchanged and renders normally. Built on `hasClonedProvenance` — the
       FAIL-SAFE, uuid-agnostic test (see clone-engines.ts) — deliberately,
       not `clonedSlotForEngine`/`libraryVoiceForEngine`: a malformed cloned
       slot (missing/non-string libraryUuid) must still count as cloned and
       still be protected here, or a malformed-but-real clone could slip
       through and get rerouted, which is the exact defect class this wave
       exists to close.

       GATE 1 M-3 — that predicate choice is right, but do NOT read the
       paragraph above as "this branch catches the malformed case". The
       THROW below also requires `(!voiceName || routeEngineUnavailable)`,
       and a malformed cloned slot resolves through `pickVoiceForEngine` to
       its non-empty human-readable `name` — so with a HEALTHY routed engine
       `voiceName` is truthy and this backstop does not fire at all. Live
       coverage for the malformed case comes from the pre-pass (which
       extracts the uuid through `libraryVoiceForEngine` and hard-fails
       `misconfigured`), not from here. The Task 21 test that covers this
       shape (`synthesise-chapter-cloned-exemption.test.ts`) passes only
       because it ALSO leaves coqui install-state unset, satisfying the
       second disjunct. The predicate still matters for the case this
       branch DOES catch — an unavailable routed engine — where treating a
       malformed slot as not-cloned would let it reroute.

       Defence-in-depth, not the live guard: the cloned-voice resolver
       pre-pass above (`resolveClonedVoicesForChapter`, ~:1119) now runs
       BEFORE any group reaches this function, over exactly the same
       cloned-and-routed characters this branch checks (including the
       orphaned-characterId narrator substitution — see the IMPORTANT-1
       fix on `rendersNarrator` above). Task 20 generalised its
       `engineUnavailableFor` signal to both qwen and coqui, so the pre-pass
       already throws `UnresolvableClonedVoiceError` first in production for
       either engine, same as it always did for qwen alone.
       This branch is retained as a backstop for any future caller that
       reaches `applyQwenFallback` without going through the pre-pass
       first (e.g. a direct unit-test harness, or a future refactor that
       adds another call site) — see `synthesise-chapter-cloned-exemption
       .test.ts`'s Task 21 cases, which defeat the pre-pass (mocking
       `characterHasClonedSlot`) specifically to exercise this backstop in
       isolation, proving it's real and not just shadowed by the pre-pass. */
    const routeEngine = route.engine;
    const clonedOnRoute = isCloneEngine(routeEngine) && hasClonedProvenance(c, routeEngine);
    const routeEngineUnavailable = isCloneEngine(routeEngine) && engineUnavailableFor(routeEngine);
    /* #2023 Piece 2 — `!!orphanedFromId` joins the existing disjuncts so a
       HEALTHY cloned narrator still raises for an orphaned-characterId line,
       not just an unavailable one. Never substitute a real person's voice
       for another character's attributed dialogue — the same guarantee this
       branch already enforces for an unresolvable clone, extended to cover
       the misattribution case.

       #2023 fix round 2 — the orphaned case gets its OWN reason
       (`misattributed-substitution`, via `fromList`), checked first and
       exclusively of `!voiceName`/`routeEngineUnavailable`. The bare
       `UnresolvableClonedVoiceError` constructor below hardcodes "the Qwen
       engine is not available this run… Re-enable Qwen" — every clause of
       that sentence is false for an orphaned id on a healthy Qwen (or a
       healthy Coqui clone, which it would also blame on Qwen): the engine is
       fine, the voice is fine, and there is no cast row to reassign. Routing
       through `fromList` gives an accurate, reason-aware message instead —
       see clone-voice-resolver.ts's `BrokenClonedVoice.orphanedCharacterId`. */
    if (clonedOnRoute && orphanedFromId) {
      throw UnresolvableClonedVoiceError.fromList([
        { name: c.name ?? c.id, reason: 'misattributed-substitution', orphanedCharacterId: orphanedFromId },
      ]);
    }
    if (clonedOnRoute && (!voiceName || routeEngineUnavailable)) {
      throw new UnresolvableClonedVoiceError(c.name ?? c.id, detail);
    }
    const needsFallback =
      route.engine === 'qwen' && (!voiceName || qwenUnavailable) && !!resolveForEngine;
    if (!needsFallback || !resolveForEngine) return { route, voiceName };
    /* fs-2 — on a non-English book the Kokoro fallback is forbidden: it would
       read the book's language through an English-only voice. fs-60 — if
       Coqui is eligible for this book's language, fall back there instead of
       failing; only a still-unsupported language (coquiEligible=false) fails
       loudly so the user designs the missing voice. */
    if (forbidKokoroFallback) {
      if (coquiEligible && resolveForEngine) {
        const coqui = resolveForEngine('coqui');
        return {
          route: { engine: 'coqui', provider: coqui.provider, modelKey: coqui.modelKey },
          voiceName: pickVoiceForEngine('coqui', toVoiceLike(c), buildHintFromCast(c)),
          renderedFallbackEngine: 'coqui',
        };
      }
      throw new MissingDesignedVoiceError(c.name ?? c.id, bookLanguage ?? 'non-English', detail);
    }
    const kokoro = resolveForEngine('kokoro');
    return {
      route: { engine: 'kokoro', provider: kokoro.provider, modelKey: kokoro.modelKey },
      voiceName: pickVoiceForEngine('kokoro', toVoiceLike(c), buildHintFromCast(c)),
      renderedFallbackEngine: 'kokoro',
    };
  };

  const castById = new Map(cast.map((c) => [c.id, c]));

  /* #2040 — resolve a group's characterId through superseded ids before
     treating it as orphaned. castById stays for the exact-id fast paths that
     legitimately want strict identity. synthesiseChapter has no book-dir
     parameter, so the id-history side-table (cast-id-history.json) cannot be
     loaded cheaply here — history defaults to {}, which still recovers the
     normalised-id tier (case/separator drift), the wave's main recovery for
     this call path. */
  const castResolver = buildCastResolver(cast);

  /* fs-38 Wave 3c, Task 23 — resolve the narrator's REAL cast row when one
     exists, instead of trusting the caller's `narratorCharacterId` blindly.
     Every route (generation.ts, chapter-splice.ts, chapter-qa-repair.ts)
     hardcodes the literal 'narrator', but a book's narrator row can
     legitimately carry the id 'char-narrator' instead — the id
     `voice-mapping.ts`'s `inferProfile` already recognises as narrator.
     Trusting 'narrator' unconditionally on such a book made every
     stub-fallback site below (the title beat, the orphaned-characterId
     safety net, and the in-chapter-id gate that decides which characters
     enter the cloned-voice pre-pass) resolve from a synthetic no-overrides
     stub instead of the real row — silently dropping to a catalogue voice
     AND, because `cast.filter`/`inChapterCharacterIds.has` can't match a
     synthetic id against the real one, skipping cloned-voice validation
     entirely (a Property-1 violation: never a silent substitution). Only
     re-resolve when the CALLER's own id has no cast match — a caller that
     legitimately points `narratorCharacterId` at some other real row keeps
     its own choice untouched. */
  const resolvedNarratorCharacterId = castById.has(narratorCharacterId)
    ? narratorCharacterId
    : (NARRATOR_CHARACTER_IDS.find((id) => castById.has(id)) ?? narratorCharacterId);

  const groups = buildSentenceGroups(sentences);

  /* Chapter-title narration (moved up from its original site just above the
     title beat, further down) is computed here because the resolver pre-pass
     right below needs it: a cloned narrator used ONLY for the title has no
     SentenceGroup of its own, so `titleText` must be known before building
     the pre-pass's in-chapter set. See `if (titleText)` further down for the
     title beat itself, unchanged. */
  const titleText = chapterTitleNarration?.trim();

  /* fs-38 Wave 3b2 — cloned-voice resolver pre-pass (spec §5.2/§5.4). Runs
     BEFORE any synth call (title or body) fires, over exactly the cloned
     Qwen voices whose character actually speaks in this chapter — never the
     whole cast, so an unrelated Broken cloned voice elsewhere in the book
     can't fail a chapter it doesn't appear in (the readiness gate). A
     Broken voice throws `UnresolvableClonedVoiceError` here, aborting the
     chapter loud before any GPU work; a Repairable voice re-derives from its
     retained master.wav and the chapter proceeds. Never substitutes — see
     the module-level invariant on `UnresolvableClonedVoiceError`. */
  if (signal?.aborted) {
    throw new DOMException('synthesiseChapter aborted', 'AbortError');
  }
  const inChapterCharacterIds = new Set(
    groups.map((g) => castResolver.resolve(g.characterId)?.character.id ?? g.characterId),
  );
  /* IMPORTANT-1 (Task 6 review) — the title beat isn't the only way the
     narrator renders unvalidated: `resolveGroup` below ALSO substitutes
     `resolveNarratorChar()` for any group whose `characterId` isn't in
     `cast` (the "orphaned characterId safety net"). Without this, a chapter
     with an orphaned-characterId sentence and no title narration would let a
     cloned-but-stale narrator voice render past the gate untouched. #2040
     narrows this to a TRUE miss: a group that resolves through the cast
     resolver (alias/normalised-id) now contributes its RESOLVED character's
     id above instead of its raw id, and must not silently drop out of the
     pre-pass just because that raw id isn't a live cast id. */
  const rendersNarrator =
    Boolean(titleText) || groups.some((g) => !castResolver.resolve(g.characterId));
  if (rendersNarrator) inChapterCharacterIds.add(resolvedNarratorCharacterId);
  /* fs-38 Wave 3c, Task 20 [ADV-C1] — per-engine "is this clone-capable
     engine unavailable this run" signal, generalising the qwen-only
     `qwenUnavailable` opt (still the source of truth for qwen — it's the
     caller's own resolved value, computed from more run context than a bare
     install-state read, see routes/generation.ts) to coqui via Task 19's
     per-engine install-state store. Coqui carries no caller-supplied
     run-level opt — nothing pre-3c ever needed one — so its signal reads
     straight off `getLastKnownCoquiInstallState()`: 'ready'/'loaded' means
     usable, everything else (including the cold-boot 'not-installed'
     default) reads unavailable, mirroring `qwenUnavailable`'s own
     not-ready-or-loaded-means-unavailable shape (routes/generation.ts). */
  const engineUnavailableFor = (e: CloneEngine): boolean => {
    if (e === 'qwen') return qwenUnavailable;
    const state = getLastKnownCoquiInstallState();
    return state !== 'ready' && state !== 'loaded';
  };

  /* fs-38 Wave 3c, Task 20 [ADV-C1] — which clone-capable engine "owns" this
     character's cloned voice, for building the ONE resolver request per
     character the brief calls for. Prefers the character's ACTUAL routed
     engine this run when IT carries the cloned slot (the common case — the
     character renders through its own clone, `wrongEngine` false). Falls
     back to whichever clone-capable engine (`CLONE_ENGINE_LIST` order —
     qwen first, the same tie-break `resolveClonedRetargetEngine` uses) DOES
     carry `provenance: 'cloned'` when the routed engine doesn't — that
     fallback is what makes `wrongEngine` diagnosable at all (Task 6b): a
     character cloned on qwen but routed to coqui/kokoro/etc. this run must
     still resolve to its qwen library entry (for the revoked check) even
     though this run's render will never touch qwen. */
  const clonedEngineFor = (c: CastCharacter, routedEngine: TtsEngine): CloneEngine => {
    if (isCloneEngine(routedEngine) && hasClonedProvenance(c, routedEngine)) return routedEngine;
    /* MINOR-3 (review) — the `.find()` below can never actually return
       undefined: every caller of `clonedEngineFor` (below) has already
       filtered `c` on `characterHasClonedSlot(c)`, which is `true` iff
       `hasClonedProvenance(c, e)` holds for at least one `e` in
       `CLONE_CAPABLE_ENGINES` — the same members `CLONE_ENGINE_LIST`
       iterates (see its own doc comment). TS still needs a fallback
       because `.find()`'s return type is `CloneEngine | undefined`; an
       explicit throw is less misleading than silently defaulting to
       'qwen', which would read as a real decision rather than "this
       should be impossible." */
    const found = CLONE_ENGINE_LIST.find((e) => hasClonedProvenance(c, e));
    if (!found) {
      throw new Error(
        `clonedEngineFor: "${c.name ?? c.id}" has no cloned slot on any clone-capable engine ` +
          `— caller must filter on characterHasClonedSlot() first.`,
      );
    }
    return found;
  };

  /* fs-38 Wave 3c, Task 20 [ADV-C1] — the load-bearing filter, generalised
     from "the routed engine's slot is cloned" to a UNION over every
     clone-capable slot (`characterHasClonedSlot`, the FAIL-SAFE whole-
     character test from clone-engines.ts) — a character cloned on Coqui
     alone now enters this pre-pass too, not just a qwen-cloned one. */
  const clonedVoiceRequests = cast
    .filter((c) => inChapterCharacterIds.has(c.id) && characterHasClonedSlot(c))
    .map((c) => {
      const routedEngine = routeFor(c).engine;
      const engine = clonedEngineFor(c, routedEngine);
      return {
        characterName: c.name ?? c.id,
        // #1813 — carried through to onVoicePrepare's payload; see
        // ClonedVoiceRequest's doc comment.
        characterId: c.id,
        /* fs-38 Wave 3c, Task 20 [ADV-C1] — Property-1 hole (Task 16 review):
           extracted through `libraryVoiceForEngine`, the SAME RESOLUTION
           predicate `pickVoiceForEngine` (voice-mapping.ts) gates the actual
           render on — not a raw `.libraryUuid` property read. A
           `provenance: 'cloned'` slot with an empty/missing/non-string
           `libraryUuid` therefore resolves to `undefined` HERE exactly as it
           would for the renderer, which `resolveClonedVoicesForChapter`'s
           existing `if (!libraryUuid)` guard already turns into a hard
           `misconfigured` failure — never a silent fall-through to a stock
           catalogue voice (see clone-voice-resolver.ts's `libraryUuid`
           handling, unchanged by this task). There is today no coqui
           analogue of the qwen-only `cloned` exemption guard in
           `applyQwenFallback` below; routing `libraryUuid` through this
           validated RESOLUTION test (rather than a raw slot read) is what
           makes this hard-fail hold for coqui too, without needing new code
           in clone-voice-resolver.ts. */
        libraryUuid: libraryVoiceForEngine(c, engine)?.libraryUuid,
        engine,
        wrongEngine: routedEngine !== engine,
        engineUnavailable: engineUnavailableFor(engine),
      };
    });
  /* [#1891] — a legacy cast.json slot can carry a qwen `libraryUuid` with NO
     `provenance` field at all (pre-dates the provenance dimension). Both
     `characterHasClonedSlot` above and `libraryVoiceForEngine` require
     `provenance` — correctly, deliberately, for the FAIL-SAFE/RESOLUTION
     roles they play elsewhere (see clone-engines.ts; five separate reviews
     have each proposed loosening one of those three predicates for a
     legacy-shape gap like this one, and each time it reintroduced the
     malformed-uuid substitution bug this wave's Global Constraints exist to
     prevent — so this fix does NOT touch them). But `pickVoiceForEngine`'s
     qwen branch (voice-mapping.ts) resolves a bare `libraryUuid` DIRECTLY,
     with no provenance check at all (a deliberate, narrower exemption —
     Review I-3 — for a qwen slot whose `name` can legitimately be blank).
     So this legacy shape renders from a real library artifact today with
     ZERO revocation check, purely because it never entered the pre-pass
     above. Fixed at THIS call site instead: feed it into the SAME resolver
     the cloned pre-pass already uses, reading the raw `libraryUuid` the
     same way the renderer will (not through the provenance-gated
     `libraryVoiceForEngine`) — so revocation is actually checked before any
     render reaches this data. Scoped to qwen only: coqui's branch of
     `pickVoiceForEngine` has no such bare-uuid exemption (it goes through
     the provenance-gated `libraryVoiceForEngine` with nothing to fall back
     on), so there is no live coqui-equivalent of this gap. A one-time
     migration stamping `provenance: 'cloned'` onto this legacy data at the
     source (voice-library.ts) is the OTHER suggested fix shape for #1891 —
     this is the runtime backstop regardless of whether that migration ever
     lands. */
  const legacyQwenLibraryRequests = cast
    .filter((c) => {
      if (!inChapterCharacterIds.has(c.id) || characterHasClonedSlot(c)) return false;
      const qwenSlot = c.overrideTtsVoices?.qwen;
      return (
        typeof qwenSlot?.libraryUuid === 'string' &&
        qwenSlot.libraryUuid.length > 0 &&
        qwenSlot.provenance === undefined
      );
    })
    .map((c) => ({
      characterName: c.name ?? c.id,
      characterId: c.id,
      libraryUuid: c.overrideTtsVoices!.qwen!.libraryUuid as string,
      engine: 'qwen' as CloneEngine,
      wrongEngine: routeFor(c).engine !== 'qwen',
      engineUnavailable: engineUnavailableFor('qwen'),
    }));
  clonedVoiceRequests.push(...legacyQwenLibraryRequests);
  /* fs-38 Wave 3b2, Task 12 (§2.3) — designed-voice orphan self-heal, over the
     SAME in-chapter readiness gate as the cloned pre-pass above. Narrower and
     gentler than the cloned resolver (see resolveDesignedVoicesForChapter's
     doc comment): the QWEN arm only repairs a missing `.pt`, never a stale
     one, and a failed self-heal never throws — it just leaves the chapter to
     whatever happens today for a missing designed voice. Skipped entirely for
     a character that doesn't actually route to Qwen this run (a book on
     Kokoro/Coqui, or Qwen globally unavailable) — self-healing a `.pt` that
     wouldn't be used this render anyway is pure waste.

     fs-38 Wave 3c, Task 20a [D-B][D-G] — the COQUI arm below is deliberately
     built on a DIFFERENT selection set, not `routeFor`/`qwenUnavailable`:
     select on "the character has an xtts slot with provenance 'designed'",
     full stop. Gating it the same way the qwen arm is gated would leave
     [DELTA-C2]'s three vectors each hitting a hard 409 where the chapter
     renders today: (1) fs-60's Qwen->Coqui fallback below reroutes a
     QWEN-ROUTED character onto coqui — `routeFor` reads 'qwen' for it, so a
     routeFor-based filter would never validate the coqui slot it's about to
     render; (2) `qwenUnavailable` has nothing to do with whether COQUI is
     usable — gating on it would skip the coqui self-heal on every run where
     Qwen merely happens to be off; (3) `clearMismatchedDesignedVoices`
     (verify-designed-voice-language.ts) deletes only the qwen slot on a
     language mismatch, leaving a stranded xtts slot with no `overrideTtsVoices
     .qwen` at all — `routeFor` still resolves an engine for that character,
     but never via a qwen-slot check, so this arm must not depend on one. */
  const designedVoiceRequests = [
    ...cast
      .filter(
        (c) => inChapterCharacterIds.has(c.id) && c.overrideTtsVoices?.qwen?.provenance === 'designed',
      )
      .filter((c) => !qwenUnavailable && routeFor(c).engine === 'qwen')
      .map((c) => ({
        characterName: c.name ?? c.id,
        characterId: c.id,
        libraryUuid: c.overrideTtsVoices?.qwen?.libraryUuid,
        engine: 'qwen' as const,
      })),
    ...cast
      .filter((c) => inChapterCharacterIds.has(c.id))
      .flatMap((c) => {
        const lib = libraryVoiceForEngine(c, 'coqui');
        if (lib?.provenance !== 'designed') return [];
        return [
          {
            characterName: c.name ?? c.id,
            characterId: c.id,
            libraryUuid: lib.libraryUuid,
            engine: 'coqui' as const,
          },
        ];
      }),
  ];
  /* fs-38 Wave 3c, Task 22 [AC-C4][FAB-I2][DELTA-C3] — partition BOTH derive
     request lists (cloned above, designed here) by engine, instead of
     running the cloned resolver then the designed resolver each over their
     own full (qwen+coqui-mixed) request list.

     The hazard: `generation.ts` awaits `ensureReadyOrPause(engine, …)`
     BEFORE `synthesiseChapter` is ever called, so Qwen is typically already
     resident the moment this pre-pass starts. Ordering the coqui derives
     after the qwen ones (or simply relocating today's two whole-list calls
     without an evict up front) fixes only the pre-pass's END state — what a
     previous draft of this task claimed and tested — while leaving the
     window it OPENS with untouched: the very first coqui derive would still
     load XTTS on top of a warm Qwen. So Qwen is evicted before ANY real
     coqui derive fires — not "before the coqui block", see fix round 1
     below for why that distinction matters. The invariant, scoped to THIS
     PRE-PASS: within it, Coqui and Qwen are never both resident at any
     point — not merely "the pre-pass ends with only Qwen resident". This
     does NOT extend past the pre-pass's own return: the anchor group
     rendered immediately after (a standalone `synthGroup` call, before
     `synthGroupsSerialized` is ever reached) can still reload XTTS on top
     of a freshly-evicted-to-Qwen state if it happens to be coqui-routed —
     `synthGroupsSerialized`'s own evict deliberately doesn't cover it
     either. Pre-existing, not introduced or worsened by this task; track it
     in plan 271 alongside this pre-pass's other known-but-out-of-scope gap
     (two books both mid coqui-derive on the same card — Node serialises
     nothing across books; the sidecar's placement controller is the only
     backstop).

     The mirror [FAB-I2]: a "coqui derives -> evict coqui -> qwen derives"
     ordering with no evict-after-coqui would leave XTTS (~3.5 GB) resident
     when the chapter's Qwen derives/render start right after — the same
     defect, mirrored. So the coqui block is ALSO evicted once it finishes —
     but ONLY when a qwen load is actually about to happen next (fix round 1
     F2 below), not merely when the chapter's BODY groups happen to route to
     qwen: `synthGroupsSerialized` below already short-circuits to
     `synthGroupsBatched` for a chapter that never mixes qwen and coqui
     groups, and "all characters on coqui" is the normal shape for a Coqui
     book — evicting XTTS unconditionally here would unload it right before
     every group reloads it, and Task 11 clears the sidecar's
     `_latents_cache` on unload, so every `.pt` would be re-read too (the
     performance-cliff DELTA-I7 exists to avoid).

     fix round 1 (F1/CRITICAL + F3) — the evict is no longer an eager,
     unconditional call in front of the whole coqui block: `evictQwenFor
     CoquiPhase` THROWS on a non-2xx response or a connection error, and a
     chapter with ONLY designed coqui voices (no cloned voice at all) must
     stay fail-SOFT (§2.3) even when the sidecar is briefly unreachable — a
     designed self-heal that can't run is supposed to just leave the voice
     alone, the same as it always did pre-Task-22. Evicting eagerly, for
     every coqui-engine REQUEST that merely EXISTS (healthy included), also
     unloaded Qwen for zero benefit on the common "everything's fine, no
     derive needed" render (F3) — a real per-chapter reload cost across a
     whole qwen-default book with a few healthy coqui clones.

     Both are fixed the same way: `deriveEngineArtifact`/`deriveEngine
     Artifact`'s COQUI callers pass a `beforeFirstDerive` hook (see
     `ResolveChapterDeps`/`ResolveDesignedVoiceDeps` in clone-voice-
     resolver.ts) that each resolver invokes itself, from INSIDE its own
     per-request try/catch, immediately before the first REAL coqui derive
     it's about to issue — never for a healthy or broken/skipped request.
     A failed evict is therefore reported through each resolver's OWN
     existing, already-differentiated failure policy: the cloned resolver's
     catch treats it as an ordinary derive failure (fail-loud — `broken`
     accumulates, `UnresolvableClonedVoiceError` still throws, satisfying
     "cloned present + evict fails still raises"); the designed resolver's
     coqui-arm catch treats it as an ordinary self-heal failure (fail-soft —
     `softFailedUuids`/keep-stale, never rethrown, satisfying "designed-only
     + evict fails still completes the chapter"). No separate try/catch is
     needed here — see `coquiEvict` below.

     fix round 2 [NEW-CRITICAL] — round 1 fixed the LEADING evict's fail-
     soft contract but left its exact mirror: `evictCoquiForQwenPhase` was
     STILL a bare top-level `await` with no enclosing try/catch anywhere in
     this function, reachable with only designed voices in the chapter
     (leading evict + coqui derive both succeed, THEN the sidecar recycles
     and the trailing evict itself 502s/ECONNREFUSEDs) — the identical
     §2.3 violation, just on the other side. Fixed the identical way: see
     `beforeFirstQwenDerive`/`qwenEvict` below, the QWEN-side mirror of
     `beforeFirstDerive`/`coquiEvict`. Also (Important) dropped the
     `coquiEvict.ok`-only gate on the trailing evict — it under-covered the
     cross-chapter case (a PRIOR chapter left Coqui resident; THIS chapter
     has only healthy coqui clones, so no new coqui derive ever ran, `ok`
     stayed false, and the trailing evict silently never fired). See the
     gate's own comment below for the replacement. */
  const clonedCoquiRequests = clonedVoiceRequests.filter((r) => r.engine === 'coqui');
  const clonedQwenRequests = clonedVoiceRequests.filter((r) => r.engine !== 'coqui');
  const designedCoquiRequests = designedVoiceRequests.filter((r) => r.engine === 'coqui');
  const designedQwenRequests = designedVoiceRequests.filter((r) => r.engine !== 'coqui');

  /* Memoised once per chapter: the FIRST resolver (cloned or designed,
     whichever reaches a real coqui derive first) that calls `hook()` pays
     for the actual evict; every later call — same or the other resolver —
     reuses the SAME settled promise (success or rejection), so a genuinely
     unreachable sidecar fails every remaining coqui derive this chapter
     the same way instead of re-attempting (and re-throwing raw) per
     request. */
  const coquiEvict: { promise: Promise<void> | null } = { promise: null };
  const beforeFirstCoquiDerive = (): Promise<void> => {
    if (!coquiEvict.promise) {
      /* #1893 reconciliation (main merge) — bounded + cancellable, like the
         render-phase evict below. The FAILURE policy here is already correct
         by construction (each resolver calls this from inside its own
         try/catch, so a failure is classified by that arm's own fail-loud /
         fail-soft rule — see this block's Task 22 comment above). What was
         missing is #1893's OTHER half: this `/unload` takes the sidecar's
         `_synth_lock`, so it can queue behind another book's in-flight synth,
         and an unbounded fetch stalled the chapter with no way to cancel.
         `withCallTimeout` is a hoisted declaration below, so it is in scope
         here; it forwards the chapter's signal and its ceiling. */
      coquiEvict.promise = withCallTimeout('qwen-evict-for-coqui-prepass', (sig) =>
        evictQwenForCoquiPhase(sig),
      );
    }
    return coquiEvict.promise;
  };

  /* fs-38 Wave 3c, Task 22 fix round 2 [NEW-CRITICAL] — the mirror, QWEN
     side. `evictCoquiForQwenPhase` used to be a bare top-level `await` with
     NO enclosing try/catch anywhere in this function — reachable with ONLY
     designed voices in the chapter (leading evict succeeds, the coqui
     derive runs or fails soft correctly, then the SIDECAR recycles and the
     trailing evict itself gets a 502/ECONNREFUSED), which aborted a chapter
     that pre-Task-22 would have rendered — the same §2.3 violation F1 fixed
     on the leading side. Fixed the identical way: no standalone top-level
     evict call at all. Instead, whichever qwen-subset resolver call reaches
     a REAL qwen derive first pays for it, from inside ITS OWN try/catch, so
     the failure is classified by that resolver's own existing policy
     (fail-loud for cloned, fail-soft for designed — see the two call sites
     in clone-voice-resolver.ts). Memoised the same way as the coqui side,
     so 15 serial qwen derives in one chapter still cost one `/unload`, not
     15. A qwen RENDER with no derive at all (every qwen voice healthy or a
     stock catalogue pick) has no resolver call to hang this off, so it's
     also primed once, best-effort, right before the qwen block below.

     `hasCoquiPresence` guard (discovered fixing the Important gate below,
     see its own comment) — a chapter with ZERO coqui-engine requests
     (`clonedCoquiRequests`/`designedCoquiRequests` both empty) never
     attempts the evict at all, even when a real qwen derive fires: Qwen is
     this project's DEFAULT engine, so a naive "always evict Coqui before
     any qwen derive" reading would hit the sidecar's `/unload` on EVERY
     qwen-cloned/designed repair in EVERY book, coqui or not — confirmed a
     real regression against synthesise-chapter.test.ts's plain, zero-coqui
     fake-timer batching suite while building this fix. Scoping to books
     that actually touch Coqui somewhere mirrors the leading evict's own
     scope (only fires when a coqui-engine request exists at all).

     GATE 1 M-5 — precise scope of what dropping the `coquiEvict.ok` gate
     actually fixed, since the fix-round note below reads broader than the
     code: it covers the cross-chapter case ONLY WHEN THIS chapter also has
     coqui-engine REQUESTS. A prior chapter that merely RENDERED coqui
     groups (catalogue voices — no cloned and no designed library voice)
     leaves XTTS resident, and a following chapter with zero coqui requests
     plus a real qwen derive returns early right here, so that derive still
     runs with XTTS resident. The narrowing is deliberate (see the
     regression above); `synthGroupsSerialized`'s render-phase evicts are
     the backstop for the residency itself ([#1894] added the trailing one). */
  const hasCoquiPresence = clonedCoquiRequests.length > 0 || designedCoquiRequests.length > 0;
  const qwenEvict: { promise: Promise<void> | null } = { promise: null };
  const beforeFirstQwenDerive = (): Promise<void> => {
    if (!hasCoquiPresence) return Promise.resolve();
    if (!qwenEvict.promise) {
      /* #1893 reconciliation (main merge) — the qwen-side mirror of
         `beforeFirstCoquiDerive`'s bound above, for the same reason. */
      qwenEvict.promise = withCallTimeout('coqui-evict-for-qwen-prepass', (sig) =>
        evictCoquiForQwenPhase(sig),
      );
    }
    return qwenEvict.promise;
  };

  /* #1813 — the LAST onVoicePrepare payload either resolver reported, tracked
     here so `withVoicePrepareHeartbeat` (below) can re-fire it on the
     `groupHeartbeatMs` cadence while a repair/self-heal derive is in flight —
     a derive can pull the VoiceDesign model in cold (~4-5 GB), which can
     exceed the client's 30s STALL_THRESHOLD_MS, and without a re-fire this
     tick would trip the exact "Worker has gone quiet" false stall this
     feature exists to prevent (same rationale as chapter_recovering's own
     10s heartbeat). `fireVoicePrepare`, not the raw `onVoicePrepare` opt, is
     what gets threaded into both deps builders below, so every onVoicePrepare
     call — from either arm, on either engine — updates this. */
  let lastVoicePrepare: { characterId: string; characterName: string } | undefined;
  const fireVoicePrepare = onVoicePrepare
    ? (e: { characterId: string; characterName: string }): void => {
        lastVoicePrepare = e;
        onVoicePrepare(e);
      }
    : undefined;
  /* Mirrors withHeartbeat's up-front-then-interval shape (below, ~synth
     phase), but the payload isn't known up front here — it's whatever the
     resolver's own onVoicePrepare callback last reported, which may be
     nothing at all (every request healthy) — so this only starts re-firing
     once at least one has, rather than firing immediately like withHeartbeat
     does for a group tick. Wraps EACH resolver call (both arms, both
     engines) independently; never merges cloned's fail-loud propagation with
     designed's fail-soft return — `fn`'s rejection/resolution passes through
     untouched. */
  async function withVoicePrepareHeartbeat<T>(fn: () => Promise<T>): Promise<T> {
    if (!onVoicePrepare || groupHeartbeatMs <= 0) return fn();
    const refire = (): void => {
      if (lastVoicePrepare) onVoicePrepare(lastVoicePrepare);
    };
    const heartbeat = setInterval(refire, groupHeartbeatMs);
    heartbeat.unref?.();
    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
    }
  }

  const cloneResolverDeps =
    clonedVoiceRequests.length > 0
      ? withDerivedUpdateEntry<ResolveChapterDeps>(
          {
            ...buildDefaultCloneResolverDeps(signal, fireVoicePrepare),
            beforeFirstDerive: beforeFirstCoquiDerive,
            beforeFirstQwenDerive,
            ...cloneResolverDepsOverride, // an explicit test override still wins, same shallow-merge contract as every other field.
          },
          cloneResolverDepsOverride,
        )
      : undefined;
  const designedResolverDeps =
    designedVoiceRequests.length > 0
      ? withDerivedUpdateEntry<ResolveDesignedVoiceDeps>(
          {
            ...buildDefaultDesignedResolverDeps(signal, fireVoicePrepare),
            beforeFirstDerive: beforeFirstCoquiDerive,
            beforeFirstQwenDerive,
            ...designedResolverDepsOverride, // ditto.
          },
          designedResolverDepsOverride,
        )
      : undefined;

  /* fs-38 Wave 3c, Task 20a [D-I2] — scope the drop to THIS CHAPTER, never
     `cast` itself (which `generation.ts` reads once and reuses for every
     chapter in the run). Unchanged from the pre-Task-22 shape, just
     extracted so it applies identically after EITHER designed-resolver call
     below — only the coqui arm ever returns a non-empty `softFailedUuids`
     (resolveDesignedVoicesForChapter's own doc comment), so applying this
     after the qwen-subset call too is a no-op there, not a behaviour
     change. */
  const applyDesignedSoftFailures = (softFailedUuids: string[]): void => {
    if (softFailedUuids.length === 0) return;
    const failed = new Set(softFailedUuids);
    for (const c of cast) {
      if (!inChapterCharacterIds.has(c.id)) continue;
      /* Task 20a fix round 1 (F3) — re-check provenance here too, via the
         SAME `libraryVoiceForEngine` RESOLUTION predicate the selection
         set above is built from, so this removal set is provably equal to
         the selection set. Without it, a uuid SHARED by two characters —
         one `designed`, one `cloned` — would delete the cloned slot too:
         `softFailedUuids` only carries uuids, not which slot(s) reported
         them, so a bare `.libraryUuid` match here would silently swap a
         real person's clone for a catalogue voice, the exact incidental-
         invariant shape `[DELTA-verified]` made explicit one function
         away (clone-voice-resolver.ts). */
      const coquiLib = libraryVoiceForEngine(c, 'coqui');
      if (coquiLib?.provenance !== 'designed' || !failed.has(coquiLib.libraryUuid)) continue;
      const { coqui: _coqui, ...restVoices } = c.overrideTtsVoices ?? {};
      castById.set(c.id, { ...c, overrideTtsVoices: restVoices });
    }
  };

  if (clonedCoquiRequests.length > 0) {
    await withVoicePrepareHeartbeat(() =>
      resolveClonedVoicesForChapter(clonedCoquiRequests, cloneResolverDeps!),
    );
  }
  if (designedCoquiRequests.length > 0) {
    /* M-1 (review, carried over) — a paused/cancelled run must stop here
       too, not keep spending GPU time on a derive nobody wants anymore. */
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const { softFailedUuids } = await withVoicePrepareHeartbeat(() =>
      resolveDesignedVoicesForChapter(designedCoquiRequests, designedResolverDeps!),
    );
    applyDesignedSoftFailures(softFailedUuids);
  }

  /* Task 22 fix round 1 (F2) — a qwen-routed BODY group is not the only way
     a qwen load is about to happen next: `inChapterCharacterIds` (above)
     deliberately adds the narrator when `chapterTitleNarration` is set, so
     a coqui book with a qwen-routed title narrator can have ZERO qwen
     *groups* while still queuing a real qwen derive in `clonedQwenRequests`/
     `designedQwenRequests` below. `groups`-only mirrored
     synthGroupsSerialized's render-phase check but missed that title-beat
     case — OR in the more direct predicate: a qwen load is about to happen
     whenever either qwen-subset request list is non-empty, in addition to
     any qwen body group. */
  const chapterHasQwenGroups = groups.some((g) => {
    /* #2040 — resolve through castResolver for the id, then read the live
       object off castById (see the identical comment in resolveGroup below):
       this runs AFTER the designedCoquiRequests self-heal above, which can
       have already mutated castById for this chapter. */
    const resolvedId = castResolver.resolve(g.characterId)?.character.id;
    const character =
      (resolvedId !== undefined ? castById.get(resolvedId) : undefined) ??
      castById.get(resolvedNarratorCharacterId) ?? {
        id: resolvedNarratorCharacterId,
        name: 'Narrator',
      };
    return routeFor(character).engine === 'qwen';
  });
  /* fix round 2 (Important) — this used to also require `coquiEvict.ok` (a
     REAL coqui derive must have SUCCEEDED THIS chapter), which under-covers
     the cross-chapter case: see `hasCoquiPresence`'s own comment above
     (`beforeFirstQwenDerive`) for the replacement condition and why a
     naive "any qwen load, full stop" reading regressed a plain zero-coqui
     Qwen chapter. The `clonedCoquiRequests`/`designedCoquiRequests` check
     here is belt-and-braces with that guard (avoids even entering the try
     below when there's nothing to protect) — the guard alone is sufficient
     for correctness.

     [NEW-CRITICAL] this priming call is deliberately best-effort: caught
     and logged, NEVER rethrown, so a sidecar recycle window here can't
     abort the chapter (the same fail-soft-by-default fix as the leading
     evict). It shares `beforeFirstQwenDerive`'s memoized promise with the
     qwen-subset resolver calls below — if it fails here, THEIR OWN
     try/catch still sees that same failure and reacts per their own policy
     (fail-loud for a cloned qwen derive, fail-soft for a designed one);
     this call only covers the "no derive needed at all, just a qwen
     RENDER" case, which has no resolver call to hang the hook off. */
  if (
    hasCoquiPresence &&
    (chapterHasQwenGroups || clonedQwenRequests.length > 0 || designedQwenRequests.length > 0)
  ) {
    try {
      await beforeFirstQwenDerive();
    } catch (err) {
      console.warn(
        '[synthesise-chapter] failed to evict Coqui ahead of a Qwen phase — continuing; a ' +
          'cloned-voice qwen derive that needs this will still fail loud per its own policy:',
        err,
      );
    }
  }

  if (clonedQwenRequests.length > 0) {
    /* Task 22 fix round 1 (F4) — restore the abort re-check this call lost:
       pre-Task-22 it ran immediately after the pre-pass's own early abort
       check with no intervening await; now it can run after the coqui
       block's (possibly slow) derives, so re-check here too, matching both
       neighbouring blocks (the designed-resolver calls) which already do. */
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    await withVoicePrepareHeartbeat(() =>
      resolveClonedVoicesForChapter(clonedQwenRequests, cloneResolverDeps!),
    );
  }
  if (designedQwenRequests.length > 0) {
    /* M-1 (review, carried over) — see the identical check above. */
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const { softFailedUuids } = await withVoicePrepareHeartbeat(() =>
      resolveDesignedVoicesForChapter(designedQwenRequests, designedResolverDeps!),
    );
    applyDesignedSoftFailures(softFailedUuids);
  }

  /* Shared synthetic-narrator stub, used wherever a narrator CastCharacter is
     needed but the book's cast has no explicit `narrator` entry. Single
     source of truth so the title beat and the orphaned-characterId fallback
     below can never diverge on what a "missing narrator" looks like. */
  const resolveNarratorChar = (): CastCharacter =>
    castById.get(resolvedNarratorCharacterId) ?? {
      id: resolvedNarratorCharacterId,
      name: 'Narrator',
    };

  /* Orphaned characterId safety net. A sentence can reference a characterId
     that has no corresponding entry in `cast` at all — e.g. a stray
     attribution to a real-world person quoted in front matter (a book's
     foreword author, an epigraph byline) that never made it into cast.json,
     or a cast/sentence-data drift between a subset re-analysis and the
     roster it produced. That is NOT the same failure as "known character,
     no voice designed" (MissingDesignedVoiceError below) — the id doesn't
     exist in the Cast view at all, so naming it in a hard error gives the
     user nothing they can act on. Fall back to the narrator's voice for
     that line instead and log once per offending id, so a data-consistency
     bug degrades a single line's delivery rather than failing the whole
     chapter. */
  const warnedUnknownCharacterIds = new Set<string>();

  /* Pool width — how many groups we *attempt* at once. At the default
     `DEFAULT_SENTENCE_CONCURRENCY` (1) this is 1 → byte-identical to the old
     serial loop, the flag-OFF safety invariant this module's default exists
     to preserve. Clamp to >= 1 (a width of 0 would dispatch nothing). */
  const poolWidth = Math.max(1, Math.floor(sentenceConcurrency));

  const chunks: Buffer[] = [];
  const segments: ChapterSegment[] = [];
  let runningBytes = 0;
  let sampleRate = 24000; // first call sets this; default matches Gemini's documented rate.

  /* Title beat: when the caller supplies a pre-built spoken phrase, prepend
     `[lead silence] + [narrator voicing the title] + [post silence]` ahead
     of the body groups. The title's TTS response anchors the chapter's
     sample rate, so the silence buffers can be sized correctly without
     guessing — we synth the title first, set the anchor from its response,
     then bracket it with silence. The title contributes one synthetic
     segment with `kind: 'title'` and an empty sentenceIds[]; the silence
     padding is deliberately NOT recorded as segments (it's not narration,
     it's structural padding, and the listen view's timeline shouldn't show
     dead-air rows). */
  let recycleRecoveries = 0;
  /* C1 in-loop recovery. Re-attempt `fn` after waiting out a sidecar respawn,
     WITHOUT discarding completed groups (the function never restarts, so every
     filled `results[]` slot survives). The shared `recycleRecoveries` counter
     bounds total recoveries per chapter; exhaustion throws RecycleStormError
     (C3). Recoverable = isTransient OR ChapterSynthTimeoutError; an abort or a
     non-recoverable error re-throws. No-op passthrough when `onRecoverRecycle`
     is absent (pre-C1). Wraps EVERY synth site (title, anchor, pool item,
     QA/ASR re-record) so recovery coverage matches the old whole-chapter loop. */
  async function withRecycleRecovery<T>(
    engineForItem: TtsEngine,
    fn: () => Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        if (!onRecoverRecycle) throw err;
        const name = (err as { name?: string })?.name;
        if (name === 'AbortError' || signal?.aborted) throw err;
        const isRecycleTimeout = name === 'ChapterSynthTimeoutError';
        if (!isTransient(err) && !isRecycleTimeout) throw err;
        if (recycleRecoveries >= maxRecycleRecoveries) {
          throw new RecycleStormError(recycleRecoveries, err);
        }
        recycleRecoveries += 1;
        /* May throw AbortError (run paused mid-wait) → propagates out as a clean
           stop, exactly like the old generation.ts recovery loop. */
        await onRecoverRecycle({ engine: engineForItem, attempt: recycleRecoveries });
      }
    }
  }

  if (titleText) {
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const narratorChar = resolveNarratorChar();
    /* The title beat speaks in the narrator's engine — which, per plan 108, is
       usually the default (Kokoro) since the narrator rarely carries a bespoke
       per-character engine. routeFor honours an explicit narrator ttsEngine if
       one is set. */
    const baseTitleRoute = routeFor(narratorChar);
    const baseNarratorVoice = pickVoiceForEngine(
      baseTitleRoute.engine,
      toVoiceLike(narratorChar),
      buildHintFromCast(narratorChar),
    );
    /* Title beat gets the same Qwen→Kokoro fallback — a Qwen narrator with no
       designed voice (or an unavailable Qwen engine) must not fail the whole
       chapter at its very first synth. */
    const titleFb = applyQwenFallback(narratorChar, baseTitleRoute, baseNarratorVoice);
    const titleRoute = titleFb.route;
    const narratorVoice = titleFb.voiceName;

    onTitleStart?.();

    const titleResult = await withRecycleRecovery(titleRoute.engine, () =>
      withCallTimeout('title', (sig) =>
        withTtsRetry(
          () =>
            titleRoute.provider.synthesize({
              text: normaliseForTts(titleText, langCode),
              voiceName: narratorVoice,
              modelKey: titleRoute.modelKey,
              language: langCode,
              /* #1951 — the title beat is a SEPARATE synth from the body's, and
                 in a normally-batched Qwen chapter it is the ONLY /synthesize
                 call. Omitting the flag here would render a German book under
                 an English chapter title. */
              cloned: hasClonedProvenance(narratorChar, 'qwen'),
              signal: sig,
            }),
          { signal: sig },
        ),
      ),
    );

    sampleRate = titleResult.sampleRate;
    const leadSilence = buildSilencePcm16(sampleRate, CHAPTER_LEAD_SILENCE_SEC);
    const postSilence = buildSilencePcm16(sampleRate, CHAPTER_POST_TITLE_SILENCE_SEC);

    chunks.push(leadSilence);
    runningBytes += leadSilence.length;
    const titleStartSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(titleResult.pcm);
    runningBytes += titleResult.pcm.length;
    const titleEndSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(postSilence);
    runningBytes += postSilence.length;

    segments.push({
      groupIndex: -1,
      characterId: narratorChar.id,
      sentenceIds: [],
      startSec: titleStartSec,
      endSec: titleEndSec,
      kind: 'title',
      renderedFallbackEngine: titleFb.renderedFallbackEngine,
      voiceName: narratorVoice,
      // The title beat never goes through pickEmotionVariantVoice, so its
      // resolved voice is already the base — no separate derivation needed.
      baseVoiceName: narratorVoice,
    });

    onTitleComplete?.({ accumulatedSec: titleEndSec });
  }

  type GroupResult = { pcm: Buffer; sampleRate: number; voiceSubstitutedFrom?: string };

  /* Resolve a group's engine route + voice ONCE (plan 108 routing), cached by
     group index. Used by the batchability partition AND by the synth calls, so
     `pickVoiceForEngine` runs at most once per group even though both consult
     it. Mixed engines reassemble cleanly because the index-order concat below
     resamples any per-engine sample-rate mismatch to the chapter anchor. */
  /* `cloned` (#1951) — is this group's character backed by a CLONED Qwen voice?
     Resolved here, alongside the route, because both synth call sites need it
     and `resolveGroup` already owns the orphaned-character fallback that
     decides WHICH character actually speaks the line. It reaches the sidecar as
     the book language on the wire; a designed voice sends none and keeps its
     manifest language. See `SynthesizeInput.cloned`. */
  type GroupRoute = {
    route: Route;
    voiceName: string;
    /** M1 (#1972 follow-up) — see `ChapterSegment.baseVoiceName`'s doc. */
    baseVoiceName: string;
    renderedFallbackEngine?: TtsEngine;
    configuredEngine: TtsEngine;
    cloned: boolean;
    /** #2023 Piece 1 — set to the cast character id that ACTUALLY spoke this
        line when the group's own `characterId` is an orphaned id (no cast
        entry at all) and the narrator was substituted for it. See
        `ChapterSegment.renderedFallbackCharacterId`'s doc comment. */
    renderedFallbackCharacterId?: string;
  };
  const resolvedByIndex = new Map<number, GroupRoute>();
  const resolveGroup = (group: SentenceGroup): GroupRoute => {
    const cached = resolvedByIndex.get(group.index);
    if (cached) return cached;
    /* #2040 — resolve the group's raw id to the CANONICAL cast id via the
       resolver (exact / alias / normalised), then do the actual character
       lookup through `castById`, not `castResolver`'s own cached object.
       `applyDesignedSoftFailures` above (Task 20a self-heal) MUTATES
       `castById` per-chapter (castById.set) to strip a soft-failed coqui
       slot; `castResolver` was built once from the ORIGINAL `cast` array and
       never sees that update, so resolving straight to its `.character`
       would keep re-deriving the failed slot every group. `castById` always
       has an entry for any id `castResolver` can resolve to, since it's
       seeded from the same array and only ever has values replaced, never
       removed. */
    const resolvedCharacterId = castResolver.resolve(group.characterId)?.character.id;
    let character = resolvedCharacterId !== undefined ? castById.get(resolvedCharacterId) : undefined;
    let orphanedFromId: string | undefined;
    if (!character) {
      if (!warnedUnknownCharacterIds.has(group.characterId)) {
        warnedUnknownCharacterIds.add(group.characterId);
        console.warn(
          `[synthesise-chapter] sentence group references characterId "${group.characterId}" ` +
            `which is not in this book's cast — falling back to the narrator voice for this line.`,
        );
      }
      character = resolveNarratorChar();
      orphanedFromId = group.characterId;
    }
    const baseRoute = routeFor(character);
    const baseVoice = pickVoiceForEngine(
      baseRoute.engine,
      toVoiceLike(character),
      buildHintFromCast(character),
    );
    /* fs-25 — Qwen-gated emotion variant. A tagged quote on a Qwen character
       with a designed variant for that emotion synthesises with the variant
       voiceId; everything else (neutral, no variant, or any non-Qwen engine)
       resolves the base voice unchanged. Applied BEFORE the Kokoro fallback so a
       designed variant counts as a present Qwen voice.

       1.7B implies prosody — on the 1.7B tier the delivery direction travels as
       an instruct phrase; pickEmotionVariantVoice returns the base voice (strict
       no-op, no __emotion suffix) so the sidecar sees the unadorned voice key. */
    const groupIs17b = baseRoute.modelKey === 'qwen3-tts-1.7b';
    const voiceForGroup = pickEmotionVariantVoice(
      baseRoute.engine,
      character.overrideTtsVoices?.qwen?.variants,
      group.emotion,
      baseVoice,
      groupIs17b,
    );
    /* Capture the CONFIGURED engine before any fallback rewrite so the SPK
       embed filter can include fallback-rendered groups (e.g. Qwen→Kokoro)
       in the correct centroid bucket. The post-fallback `route.engine` would
       read 'kokoro' for a fallen-back Qwen group and would erroneously exclude
       it from the stochastic-engine embed pass (Task 9 scores those renders
       against the Qwen centroid to detect the drift). */
    const configuredEngine = baseRoute.engine;
    /* Resolve once (used by both the batchability partition AND the synth
       call), so the fallback is decided in one place — the partition then
       sees the post-fallback Kokoro engine and routes the group as a Kokoro
       single item, not a Qwen batch item. */
    const fallback = applyQwenFallback(
      character,
      baseRoute,
      voiceForGroup,
      orphanedFromId
        ? `(This line's original characterId "${orphanedFromId}" is not in this book's cast and ` +
            `was substituted with the narrator — that substitution is what's failing here, not a ` +
            `narrator dialogue line.)`
        : undefined,
      orphanedFromId,
    );
    const r = {
      ...fallback,
      configuredEngine,
      /* Tested against 'qwen' specifically — the only engine whose synth honours
         a per-request language for clones. Coqui gets a BCP-47 code for EVERY
         voice regardless, so its own cloned slots need no flag. Uses the
         FAIL-SAFE `hasClonedProvenance` (not the uuid-validating
         `clonedSlotForEngine`), matching the cloned-voice exemption at
         verify-designed-voice-language.ts:55 that this flag exists to complete.
         Emotion variants fall out for free: the VARIANT voiceId is what gets
         synthesised, but provenance lives on the CHARACTER, so a variant of a
         cloned voice is still flagged. */
      cloned: hasClonedProvenance(character, 'qwen'),
      /* M1 (#1972 follow-up) — the pre-emotion-variant voice for the
         CHARACTER-level snapshot. A fallback reroute (Kokoro/Coqui) already
         carries no emotion suffix — its OWN voiceName IS the base — so only
         the non-rerouted path needs the pre-variant `baseVoice`. */
      baseVoiceName: fallback.renderedFallbackEngine ? fallback.voiceName : baseVoice,
      /* #2023 Piece 1 — `character` has already been reassigned to the
         resolved narrator above when `orphanedFromId` is set, so `character.id`
         is exactly who spoke this line. Undefined on every normal group. */
      renderedFallbackCharacterId: orphanedFromId ? character.id : undefined,
    };
    resolvedByIndex.set(group.index, r);
    return r;
  };

  /* Run `fn` while a stall-resetting `onGroupStart` tick fires for `tickGroup`
     — once up front, then every `groupHeartbeatMs` until `fn` settles.

     Each TTS call (single OR batched) can run for many seconds, and the
     client's stall detector only sees inactivity, not "active work on a long
     call" — without this beat the user sees "Worker has gone quiet" for what is
     actually a healthy in-flight synth. The GPU token is also acquired INSIDE
     the provider call, so a call blocked behind a sibling chapter in the
     semaphore FIFO would otherwise go silent until the token frees. A BATCHED
     call covers N sentences in one shot and can run longer than a single one,
     so the heartbeat matters more, not less, here (plan 112). Re-uses the
     existing onGroupStart→progress plumbing — no new tick type. The accumulated
     time is a running estimate; authoritative per-segment timing is computed in
     the deterministic index-order pass after all work settles. Disabled when
     `groupHeartbeatMs <= 0` or no callback. */
  async function withHeartbeat<T>(tickGroup: SentenceGroup, fn: () => Promise<T>): Promise<T> {
    const fireGroupStart = (): void =>
      onGroupStart?.({
        group: tickGroup,
        totalGroups: groups.length,
        accumulatedSec: pcmDurationSec(runningBytes, sampleRate),
        /* Read the shared counter at fire time — the heartbeat fires while the
           call (and any sibling in-flight item) runs, so this is the live
           "done so far" value, identical for every concurrent worker. */
        completed: completedCount,
      });
    fireGroupStart();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    if (onGroupStart && groupHeartbeatMs > 0) {
      heartbeat = setInterval(fireGroupStart, groupHeartbeatMs);
      /* Don't keep the event loop alive for the heartbeat alone. */
      heartbeat.unref?.();
    }
    try {
      return await fn();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }

  /* Defensive per-call ceiling (plan 148). Races a provider call against a
     timer: on timeout we abort a derived AbortController (cancelling the
     in-flight fetch) and reject with a non-transient {@link
     ChapterSynthTimeoutError}, so a runaway/never-returning call fails the
     chapter instead of hanging the queue. The derived controller chains the
     parent `signal`, so an outer abort still propagates. `callTimeoutMs <= 0`
     disables the timer and forwards the parent signal unchanged. */
  async function withCallTimeout<T>(
    label: string,
    run: (sig: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    if (callTimeoutMs <= 0) return run(signal);
    const ctrl = new AbortController();
    const onParentAbort = (): void => ctrl.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', onParentAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl.abort();
        reject(new ChapterSynthTimeoutError(label, callTimeoutMs));
      }, callTimeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([run(ctrl.signal), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onParentAbort);
    }
  }

  /* Single-sentence synth. Returns the RAW provider result; the caller stores
     it by index and concatenates later, so this never touches `chunks`,
     `runningBytes`, or `segments` (which would race under parallel workers).

     `normaliseForTts` scrubs all-caps runs and em/en-dashes immediately before
     the synth — XTTS otherwise spells multi-word all-caps openers letter-by-
     letter ("ONE" → "oh-en-ee") and loops on em-dashes. Idempotent; segment
     metadata still references the original SentenceOutput so UI captions and
     quote audits are unaffected. Wrapped in `withTtsRetry` so the queue absorbs
     flaky transients; non-transient throws bubble out as today's
     `chapter_failed`. */
  async function synthGroup(group: SentenceGroup): Promise<GroupResult> {
    const { route, voiceName, cloned } = resolveGroup(group);
    return withHeartbeat(group, () =>
      withCallTimeout('synthesize', (sig) =>
        withTtsRetry(
          () =>
            route.provider.synthesize({
              text: normaliseForTts(group.text, langCode),
              voiceName,
              modelKey: route.modelKey,
              language: langCode,
              cloned,
              signal: sig,
            }),
          {
            signal: sig,
            onRetry: (info) =>
              onGroupRetry?.({
                group,
                totalGroups: groups.length,
                attempt: info.attempt,
                backoffMs: info.backoffMs,
                reason: info.reason,
              }),
          },
        ).then((result) => ({
          pcm: result.pcm,
          sampleRate: result.sampleRate,
          voiceSubstitutedFrom: result.voiceSubstitutedFrom,
        })),
      ),
    ).catch((err) => {
      logSynthTimeoutOffender(err, [group]);
      throw err;
    });
  }

  /* TRUE batching (plan 112): synth N Qwen sentences in ONE batched forward.
     All groups in `batchGroups` route to the same Qwen provider + modelKey
     (qwen resolves to a single cached provider), but each carries its OWN voice
     — `synthesizeBatch` sends a per-element prompt list, so a batch may MIX the
     narrator + dialogue voices. Returns the N PCM chunks in input order; the
     caller scatters each back to its group's own `results[index]` slot, so the
     downstream index-order concat is identical to the single-call path. The
     heartbeat ticks for the batch's lead group while the (longer) call runs.
     Retry wraps the WHOLE batch — a batch is atomic at the model layer, so a
     transient replays it and a permanent failure fails the chapter as today. */
  async function synthBatch(batchGroups: SentenceGroup[]): Promise<SynthesizeBatchOutput> {
    const lead = batchGroups[0];
    const { route } = resolveGroup(lead);
    const batchFn = route.provider.synthesizeBatch;
    /* Partition only ever puts groups here when the provider advertises batch,
       but guard so a future routing change degrades safely rather than throws. */
    if (!batchFn) {
      throw new Error('synthBatch called for a provider without synthesizeBatch.');
    }
    /* fs-57 — derive is17b from the lead group's resolved model key. All groups
       in a batch share the same Qwen provider + modelKey (the partition ensures
       this), so one derivation covers the whole batch. */
    const is17b = route.modelKey === 'qwen3-tts-1.7b';
    const items = batchGroups.map((g) => {
      const { voiceName, cloned } = resolveGroup(g);
      return {
        text: normaliseForTts(g.text, langCode),
        voiceName,
        /* #1951 — per ITEM, because this batch may mix a cloned character's
           line with a designed narrator's and they need different languages
           in the same forward. The language itself is batch-level below. */
        cloned,
        /* 1.7B implies prosody — attach the resolved instruct phrase when is17b.
           resolveInstructForGroup returns {} when is17b=false,
           so the spread is a no-op on the 0.6B path. */
        ...resolveInstructForGroup(g, { is17b }),
        /* Forward the group's emotion so the sidecar can look up the
           _LIVE_INSTRUCT_GAIN.  Absent/neutral groups send no key → unity gain. */
        ...(g.emotion != null ? { emotion: g.emotion } : {}),
      };
    });
    const out = await withHeartbeat(lead, () =>
      withCallTimeout('batch', (sig) =>
        withTtsRetry(
          () =>
            batchFn.call(route.provider, {
              items,
              modelKey: route.modelKey,
              liveInstruct: is17b,
              /* #1951 — one chapter = one book = one language. Per-item
                 `cloned` above decides which items actually put it on the
                 wire. */
              language: langCode,
              signal: sig,
            }),
          {
            signal: sig,
            onRetry: (info) =>
              onGroupRetry?.({
                group: lead,
                totalGroups: groups.length,
                attempt: info.attempt,
                backoffMs: info.backoffMs,
                reason: info.reason,
              }),
          },
        ),
      ),
    ).catch((err) => {
      logSynthTimeoutOffender(err, batchGroups);
      throw err;
    });
    /* Live per-batch RTF beacon (plan 127). Only when the sidecar reported its
       compute timing; a zero/absent audioMs means "not reported", skip. */
    if (out.genMs != null && out.audioMs != null && out.audioMs > 0) {
      onBatchComplete?.({ batchSize: batchGroups.length, genMs: out.genMs, audioMs: out.audioMs });
    }
    return out;
  }

  /* Body dispatch — bounded-concurrency worker pool over WORK ITEMS (plan 107
     parallelised sentence groups; plan 112 lets a work item be a BATCH of Qwen
     sentences synthesised in one call). `poolWidth` workers pull from a shared
     cursor (mirrors plan 87's chapter pool in `server/src/routes/generation.ts`).
     The semaphore inside every provider call is the real GPU governor; this
     pool only governs how many items are *in flight* at the Node layer.

     Determinism under parallelism rests on three rules, all paired with tests
     in `synthesise-chapter.test.ts`:

       1. PCM ORDER — each worker writes its result(s) into pre-sized
          `results[group.index]` slot(s) (a batch scatters one chunk per
          covered group). We never push to `chunks` from a worker; concat
          happens in a single index-order pass AFTER all work settles, so
          neither completion order nor batch packing can reorder the audio.
       2. SAMPLE-RATE ANCHOR — fixed BEFORE dispatch: the title rate when a
          title beat ran, else `groups[0]`'s rate, synthed up front as a SINGLE
          call (never inside a batch), NOT the first item to complete.
       3. STALL WATCHDOG — `onGroupStart` fires (and re-fires on the heartbeat)
          as each item begins, so the 30 s client watchdog (`STALL_THRESHOLD_MS`,
          `src/store/chapters-slice.ts`) keeps resetting even across a long
          batched call. `onGroupComplete` fires per covered group. Final
          per-segment `startSec`/`endSec` are computed in the index-order pass
          below — only there is the cumulative offset deterministic. */

  const results: (GroupResult | undefined)[] = new Array(groups.length);
  let completedCount = 0;
  const fireComplete = (group: SentenceGroup): void => {
    completedCount += 1;
    onGroupComplete?.({
      group,
      totalGroups: groups.length,
      accumulatedSec: 0, // recomputed deterministically in the index-order pass.
      completed: completedCount,
    });
  };

  /* Anchor the chapter's output rate before dispatch. If a title beat ran,
     `chunks` already holds the title PCM and `sampleRate` is its rate — keep
     it. Otherwise synth the lowest-index body group up front (as a SINGLE call,
     even if it's Qwen-batchable) so its rate is the deterministic anchor
     regardless of which item the pool finishes first. */
  let bodyStartIndex = 0;
  if (chunks.length === 0 && groups.length > 0) {
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const anchorGroup = groups[0];
    const result = await withRecycleRecovery(resolveGroup(anchorGroup).route.engine, () =>
      synthGroup(anchorGroup),
    );
    results[anchorGroup.index] = result;
    sampleRate = result.sampleRate;
    fireComplete(anchorGroup);
    bodyStartIndex = 1;
  }

  /* Synthesise an arbitrary list of groups through the batched dispatch and
     return each group's PCM by index. Every Qwen group whose provider advertises
     `synthesizeBatch` is collected (regardless of narrative adjacency — a non-Qwen
     group interleaving doesn't break a batch) and packed into `batchSize`-capped,
     modelKey-bucketed, length-sorted, token-budgeted batches sent as ONE call;
     everything else (non-Qwen, or `batchSize === 1` — the per-call kill-switch)
     stays a single call. Scatter-back is by `group.index`, so the downstream
     index-order concat is identical regardless of batch composition. Abort +
     recycle-recovery wrap every call; `onDone(group, result)` fires per group as
     its PCM lands — the initial body pass uses it to write `results` + stream
     chapter progress; the QA re-record passes omit it and read the returned map.

     Used by BOTH the initial body dispatch AND the QA re-record loops, so a
     re-record round costs ONE batched call covering all of its suspect/drift
     sentences instead of one single call per sentence — the unbatched per-group
     re-record was the ~2x RTF regression on Qwen chapters.

     Determinism rests on the same rules tested in synthesise-chapter.test.ts:
       1. PCM ORDER — results keyed by `group.index`; batch packing never reorders.
       2. SAMPLE-RATE ANCHOR — fixed before this runs (the anchor group above).
       3. STALL WATCHDOG — synthGroup/synthBatch tick the heartbeat per (lead)
          group, so a long batched call keeps feeding the no-progress watchdog. */
  const batchSize = Math.max(1, Math.floor(qwenBatchSize));
  const tokenBudget = Math.floor(qwenBatchTokenBudget);
  /* 1.7B tier-aware caps (8 GB OOM guard) — applied to the 1.7B bucket only. */
  const batchSize17b = Math.max(1, Math.floor(qwenBatchSize17b));
  const tokenBudget17b = Math.floor(qwenBatchTokenBudget17b);
  type WorkItem =
    | { kind: 'single'; group: SentenceGroup }
    | { kind: 'batch'; groups: SentenceGroup[] };
  const isBatchable = (group: SentenceGroup): boolean => {
    const { route } = resolveGroup(group);
    return route.engine === 'qwen' && typeof route.provider.synthesizeBatch === 'function';
  };
  async function synthGroupsBatched(
    groupList: SentenceGroup[],
    onDone?: (group: SentenceGroup, result: GroupResult) => void,
  ): Promise<Map<number, GroupResult>> {
    const out = new Map<number, GroupResult>();
    const workItems: WorkItem[] = [];
    /* Partition batchable groups by modelKey so 1.7B and 0.6B groups NEVER share
       a batch — the sidecar runs a single-model forward and mixing model tiers
       would cause a prompt-tensor dim mismatch. */
    const batchableByModel = new Map<string, SentenceGroup[]>();
    for (const group of groupList) {
      if (batchSize > 1 && isBatchable(group)) {
        const { route } = resolveGroup(group);
        const bucket = batchableByModel.get(route.modelKey) ?? [];
        bucket.push(group);
        batchableByModel.set(route.modelKey, bucket);
      } else {
        workItems.push({ kind: 'single', group });
      }
    }
    /* Model-side length precomputed once across all batchable groups — shared by
       the length-bucketing sort (plan 128) and the token-budget packer (plan 136).
       1.7B implies prosody: on the 1.7B tier the effective length includes the
       resolved instruct text so the packer accounts for the extra decode tokens a
       long-instruct batch consumes. 0.6B groups carry no instruct → 0 extra chars,
       counted uniformly. Neutral items carry no phrase → 0 extra chars. */
    const allBatchable: SentenceGroup[] = Array.from(batchableByModel.values()).flat();
    const lenOf = new Map(allBatchable.map((g) => {
      const textLen = normaliseForTts(g.text, langCode).length;
      const { route } = resolveGroup(g);
      const is17b = route.modelKey === 'qwen3-tts-1.7b';
      const instructLen = resolveInstructForGroup(g, { is17b }).instruct?.length ?? 0;
      return [g, textLen + instructLen] as const;
    }));
    const pushBatch = (slice: SentenceGroup[]): void => {
      workItems.push(
        slice.length === 1 ? { kind: 'single', group: slice[0] } : { kind: 'batch', groups: slice },
      );
    };
    /* Process each per-modelKey bucket independently so a slice never crosses a
       model-tier boundary. The 1.7B bucket packs to its own SMALLER caps (8 GB
       OOM guard) while 0.6B keeps the defaults — a mixed-tier chapter sizes each
       tier's batches to that tier's VRAM cost. */
    for (const [bucketModelKey, batchable] of batchableByModel.entries()) {
      const is17bBucket = bucketModelKey === 'qwen3-tts-1.7b';
      const effBatchSize = is17bBucket ? batchSize17b : batchSize;
      const effTokenBudget = is17bBucket ? tokenBudget17b : tokenBudget;
      /* Length-bucketing (plan 128): order by model-side length, tie-break by
         `group.index`. Output-preserving: scatter-back is by `group.index`. */
      if (qwenBatchBucket && batchable.length > 1) {
        batchable.sort((a, b) => lenOf.get(a)! - lenOf.get(b)! || a.index - b.index);
      }
      if (effTokenBudget <= 0) {
        /* Fixed-width slicing (plans 113/128) — back-compat path + kill-switch. */
        for (let i = 0; i < batchable.length; i += effBatchSize) {
          pushBatch(batchable.slice(i, i + effBatchSize));
        }
      } else {
        /* Token-budget packing (plan 136): greedily fill while
           `count × maxLenInBatch <= effTokenBudget` AND `count <= effBatchSize`; a
           single item that alone exceeds the budget forms its own batch. */
        let current: SentenceGroup[] = [];
        let currentMax = 0;
        for (const g of batchable) {
          const candLen = lenOf.get(g)!;
          let candMax = Math.max(currentMax, candLen);
          const nextCount = current.length + 1;
          if (current.length > 0 && (nextCount * candMax > effTokenBudget || nextCount > effBatchSize)) {
            pushBatch(current);
            current = [];
            currentMax = 0;
            candMax = candLen;
          }
          current.push(g);
          currentMax = candMax;
        }
        if (current.length > 0) pushBatch(current);
      }
    }
    const firstIndexOf = (item: WorkItem): number =>
      item.kind === 'single' ? item.group.index : item.groups[0].index;
    workItems.sort((a, b) => firstIndexOf(a) - firstIndexOf(b));

    /* Index-pulling worker pool over the work items. `poolWidth` workers share
       `nextItem`; each runs its item and stores result(s) by `group.index`. At
       `poolWidth === 1` this is a serial walk. */
    let nextItem = 0;
    const effectiveWidth = Math.min(poolWidth, Math.max(1, workItems.length));
    const workers: Promise<void>[] = [];
    for (let w = 0; w < effectiveWidth; w++) {
      workers.push(
        (async () => {
          for (;;) {
            /* Cheap abort check before claiming the next item. The provider also
               receives the signal so a mid-call abort is honoured. */
            if (signal?.aborted) {
              throw new DOMException('synthesiseChapter aborted', 'AbortError');
            }
            const i = nextItem++;
            if (i >= workItems.length) return;
            const item = workItems[i];
            if (item.kind === 'single') {
              const r = await withRecycleRecovery(resolveGroup(item.group).route.engine, () =>
                synthGroup(item.group),
              );
              out.set(item.group.index, r);
              onDone?.(item.group, r);
            } else {
              const res = await withRecycleRecovery(resolveGroup(item.groups[0]).route.engine, () =>
                synthBatch(item.groups),
              );
              /* Scatter each batched chunk back to ITS OWN group index — this is
                 what keeps the index-order concat below identical to the per-call
                 path. */
              item.groups.forEach((g, k) => {
                const r = { pcm: res.pcms[k], sampleRate: res.sampleRate };
                out.set(g.index, r);
                onDone?.(g, r);
              });
            }
          }
        })(),
      );
    }
    await Promise.all(workers);
    return out;
  }

  /* fs-60 — drop-in wrapper around synthGroupsBatched that adds the Qwen/Coqui
     serialization guarantee, for use at EVERY dispatch site in this function,
     not just the initial body dispatch. A re-record round (segment-QA or ASR)
     can re-synth a mixed pending set exactly as easily as the initial dispatch
     can — partitioning only the initial call would leave Coqui resident from
     its own second phase while a re-record round reloads Qwen, which is the
     exact co-residency this mechanism exists to prevent. Same signature as
     synthGroupsBatched (groupList, optional onDone) => Map<index, result>, so
     it's a drop-in replacement at every call site. When the group list doesn't
     actually mix qwen+coqui, this is a zero-overhead passthrough to
     synthGroupsBatched. Cost note: if MULTIPLE re-record rounds each mix
     engines, this evicts+reloads Qwen once per such round — a real perf cost,
     accepted deliberately in exchange for correctness; not optimized away in
     this task (redundant-evict avoidance is a follow-up, not a v1 requirement).
     NOT applied to the chapter's anchor group (the very first body group,
     rendered by a standalone synthGroup call before this function is ever
     reached, to fix the sample-rate anchor per plan 107/113) — see this
     task's accepted-limitations note below for why that narrow gap is
     accepted rather than engineered around. */
  async function synthGroupsSerialized(
    groupList: SentenceGroup[],
    onDone?: (group: SentenceGroup, result: GroupResult) => void,
  ): Promise<Map<number, GroupResult>> {
    const engines = new Set(groupList.map((g) => resolveGroup(g).route.engine));
    if (!(engines.has('qwen') && engines.has('coqui'))) {
      return synthGroupsBatched(groupList, onDone);
    }
    /* fs-60 — Coqui renders in its own phase AFTER Qwen is evicted; every other
       engine (Qwen itself, plus any lightweight per-character pin such as
       Kokoro/Gemini) renders in the pre-evict phase. Splitting on "coqui vs
       not-coqui" — rather than "qwen vs coqui" — guarantees no group is dropped
       when a chapter mixes a third engine alongside the qwen+coqui pair: the
       invariant this wrapper enforces is specifically that Coqui is never
       resident alongside Qwen, not that only two engines are ever present. */
    const coquiGroups = groupList.filter((g) => resolveGroup(g).route.engine === 'coqui');
    const preEvictGroups = groupList.filter((g) => resolveGroup(g).route.engine !== 'coqui');
    const out = new Map<number, GroupResult>();
    for (const [k, v] of await synthGroupsBatched(preEvictGroups, onDone)) out.set(k, v);
    /* #1893 — the evict is VRAM hygiene, not a correctness gate, so a failed
       one must not abort a chapter that would otherwise render. Two gaps were
       open here: `evictQwenForCoquiPhase` throws on a non-ok `/unload` and
       `fetch` rejects on a dead socket, and neither had any enclosing
       try/catch between here and `synthesiseChapter`'s head — so a transient
       sidecar hiccup killed the chapter. Failing soft costs little: the
       sidecar's `/unload` is idempotent and 200s even when nothing was
       resident (main.py's unload_model), so a failure here usually means an
       unhealthy sidecar, which the Coqui phase below then surfaces with its
       own error. NOT always, though — a wrong/proxied SIDECAR_URL can 5xx
       `/unload` while the synth path is perfectly healthy, in which case
       Coqui really does load on top of a resident Qwen and an 8 GB card can
       OOM. That residue is what on-box register row A19 exists to settle;
       if it shows a recycle storm rather than a clean render or a specific
       sidecar error, this policy is the thing to revisit. Fail-soft +
       abort-rethrow mirror clone-voice-resolver.ts's best-effort self-heal.

       Bounded by the same per-call ceiling the synth calls use rather than a
       tighter one: this `/unload` can legitimately queue behind ANOTHER
       book's in-flight synth on the sidecar's `_synth_lock` (see this
       function's header — cross-book serialization lives in the sidecar
       now), so waiting is often correct and only waiting FOREVER is not. An
       unbounded fetch here stalled the chapter with no way to cancel it.
       Two consequences of reusing that ceiling, both fine at defaults but
       worth knowing: `callTimeoutMs: 0` disables it and re-opens the
       unbounded wait; and the evict is not inside `withHeartbeat`, so a
       full-ceiling timeout burns 600s of the 720s CHAPTER_NO_PROGRESS_MS
       budget (generation.ts sizes that default deliberately above this
       ceiling) — raising SIDECAR_CALL_TIMEOUT_MS or lowering the watchdog
       makes the stall guard fire before this fail-soft path is reached. */
    try {
      await withCallTimeout('qwen-evict-for-coqui', (sig) => evictQwenForCoquiPhase(sig));
    } catch (err) {
      /* An abort is the run being paused/cancelled — stop, don't swallow it
         as an ordinary best-effort failure (clone-voice-resolver.ts's M-1).
         Rethrow something that still NAMES itself an abort, rather than the
         raw rejection: `signal.aborted` catches a pause that raced a plain
         socket-death rejection, but rethrowing that TypeError verbatim would
         read as a real chapter failure at routes/generation.ts's
         `err.name === 'AbortError'` pause detector — the same trap
         clone-voice-resolver.ts's `abortRejection` (review I-1) exists to
         avoid. Prefer the signal's own reason, which is a genuine AbortError
         DOMException for the bare `controller.abort()` every caller uses. */
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError' || signal?.aborted) {
        throw name === 'AbortError'
          ? err
          : (signal?.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }
      console.warn(
        `[synthesise-chapter] fs-60 Qwen→Coqui evict failed; continuing into the Coqui phase ` +
          `without it (Coqui may load alongside a still-resident Qwen):`,
        err,
      );
    }
    for (const [k, v] of await synthGroupsBatched(coquiGroups, onDone)) out.set(k, v);
    /* [#1894] — the missing half of fs-60's eviction. This wrapper evicted
       Qwen FOR the Coqui phase but never the reverse, so XTTS (~3.5 GB)
       stayed resident for the whole rest of the render: into the next
       chapter, which on this project's Qwen-default books usually has no
       Coqui work at all and is exactly the render XTTS then crowds out.

       Placed HERE, at the end of the Coqui phase, because this is the one
       point where "no further Coqui work is queued" is a FACT rather than a
       prediction: the Coqui phase is the last thing this dispatch does. That
       matters — #1894 records a near-miss where gating a different evict on
       "a Qwen load is imminent" over-triggered on nearly every chapter of
       nearly every book (Qwen is the default engine) and broke an unrelated
       fake-timer batching suite. This gate is not that: it is the exact
       mirror of the `evictQwenForCoquiPhase()` call three lines up, under
       the identical mixed-engine condition, so it fires only where that one
       already does. A chapter that never mixes engines short-circuits above
       and is untouched.

       The engine-partition invariant is preserved, not weakened: the
       sequence is preEvict → evict qwen → coqui → evict coqui, so the two
       are never co-resident at any point. Cost is symmetric with the leading
       evict — a mixed chapter reloads XTTS (and its `_latents_cache`, which
       Task 11 clears on unload) once per mixed dispatch — and is accepted
       deliberately: 3.5 GB held across an entire book is the worse trade.

       Fail-SOFT, deliberately and unlike the leading evict: every group is
       already synthesised by the time this runs, so letting a sidecar
       recycle window (502/ECONNREFUSED on `/unload`) throw here would
       destroy a chapter's completed work purely to free VRAM — the exact
       §2.3 shape #1893 and Task 22 fix round 2 each closed elsewhere. The
       leading evict's own bare `await` is untouched here; it is a separate
       finding with its own reconciliation against main. */
    try {
      /* #1893 reconciliation (main merge) — bounded + cancellable, matching
         the leading `qwen-evict-for-coqui` call above. The fail-soft policy
         here was already right (see the comment above); what main added and
         this mirror lacked is the ceiling: an unbounded `/unload` queued
         behind another book's `_synth_lock` could stall a chapter whose
         groups are ALL already synthesised, purely to free VRAM. */
      await withCallTimeout('coqui-evict-after-coqui-phase', (sig) => evictCoquiForQwenPhase(sig));
    } catch (err) {
      console.warn(
        '[synthesise-chapter] failed to evict Coqui after the chapter’s Coqui phase — continuing; ' +
          'XTTS stays resident until the next unload:',
        err,
      );
    }
    return out;
  }

  /* Initial body dispatch — synth groups[bodyStartIndex..] (the anchor already
     ran), writing each result into `results` and streaming chapter progress as
     it lands. */
  await synthGroupsSerialized(groups.slice(bodyStartIndex), (group, result) => {
    results[group.index] = result;
    fireComplete(group);
  });

  /* Pre-assembly per-sentence QA gate. Every body group's PCM is now in
     `results[group.index]`, still UN-concatenated, so a bad sentence can be
     re-recorded in place before assembly (the user heard dropped / silent /
     runaway single sentences slip through the chapter-level gate, which only
     sees whole-chapter loudness + total duration). Suspect groups are re-synthed
     in BATCHED rounds (synthGroupsBatched): each round re-records ALL still-
     suspect sentences in one call, keeps the best take, and — if a group still
     fails after `maxSegmentRerecords` rounds — keeps the least-bad take and
     stamps it `suspect` (never block completion). `0` skips the gate entirely
     (byte-identical to pre-gate). Batching the re-records (vs the old one-call-
     per-suspect loop) is the ~2x RTF fix; each suspect group still gets at most
     `maxSegmentRerecords` re-synths (one per round), so the budget is unchanged. */
  /* B1 — QA-cost wall split out for the rerecordRtf telemetry. Each accumulator
     wraps exactly one class of await so the chapter wall can be attributed:
     rerecordMs = QA-driven re-record synth (the part PR-1 moves); transcribeMs +
     embedMs = the always-on verify floor. `timed()` below dedupes the
     Date.now()-before/after bookkeeping shared by every accumulated call. */
  let rerecordMs = 0;
  let transcribeMs = 0;
  let embedMs = 0;
  const timed = async <T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> => {
    const t0 = Date.now();
    const value = await fn();
    return { value, ms: Date.now() - t0 };
  };

  const segmentQaByIndex = new Map<number, SegmentQaVerdict>();
  const qaRetryCountByIndex = new Map<number, number>();
  if (maxSegmentRerecords > 0) {
    /* `ok` beats `suspect`; among two suspects, fewer reasons is less-bad. */
    const isBetter = (a: SegmentQaVerdict, b: SegmentQaVerdict): boolean => {
      if (a.status !== b.status) return a.status === 'ok';
      return a.reasons.length < b.reasons.length;
    };
    /* Best take per group + its current verdict (held in segmentQaByIndex),
       seeded from the initial synth. */
    const best = new Map<number, GroupResult>();
    for (const group of groups) {
      const r = results[group.index];
      if (!r) continue;
      best.set(group.index, r);
      segmentQaByIndex.set(
        group.index,
        evaluateSegmentPcm(r.pcm, r.sampleRate, group.text, segmentQaThresholds),
      );
    }
    for (let attempt = 1; attempt <= maxSegmentRerecords; attempt++) {
      if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
      const pending = groups.filter(
        (g) => results[g.index] && segmentQaByIndex.get(g.index)!.status === 'suspect',
      );
      if (pending.length === 0) break;
      for (const group of pending) {
        qaRetryCountByIndex.set(group.index, (qaRetryCountByIndex.get(group.index) ?? 0) + 1);
        onSegmentRerecord?.({
          group,
          attempt,
          maxRerecords: maxSegmentRerecords,
          reasons: segmentQaByIndex.get(group.index)!.reasons,
        });
      }
      const { value: fresh, ms: reMs } = await timed(() => synthGroupsSerialized(pending));
      rerecordMs += reMs;
      for (const group of pending) {
        const f = fresh.get(group.index);
        if (!f) continue;
        const freshVerdict = evaluateSegmentPcm(f.pcm, f.sampleRate, group.text, segmentQaThresholds);
        if (isBetter(freshVerdict, segmentQaByIndex.get(group.index)!)) {
          best.set(group.index, f);
          segmentQaByIndex.set(group.index, freshVerdict);
        }
      }
    }
    /* Commit the best take per group (verdicts already live in segmentQaByIndex). */
    for (const group of groups) {
      if (!results[group.index]) continue;
      results[group.index] = best.get(group.index)!;
    }
  }

  /* ASR content-QA pass (srv-31). Runs AFTER the signal-QA loop on the now-final
     per-group PCM, catching the one defect class the signal checks can't see: a
     fluent, right-length, right-loudness sentence that says the WRONG words.
     Each sampled body group is transcribed and word-error-rated against its
     text; a `drift` verdict is re-recorded (best-of-N by WER), an `inconclusive`
     one (untrusted transcript) is left alone. A segment still `drift` after the
     retries is kept and flagged `asrSuspect` — flag + surface, never block
     (the decided persistent-drift policy). Inline here, but the multi-worker
     queue overlaps this chapter's CPU ASR with the next chapter's GPU synth. */
  const segmentAsrByIndex = new Map<number, AsrClassification>();
  const asrRetryCountByIndex = new Map<number, number>();
  if (asr) {
    const sampleEvery = Math.max(1, Math.floor(asr.sampleEvery ?? 1));
    const maxAsrRerecords = Math.max(0, Math.floor(asr.maxRerecords ?? 0));
    /* ok < inconclusive < drift; among equal verdicts, lower WER wins. */
    const rank = (c: AsrClassification): number =>
      c.verdict === 'ok' ? 0 : c.verdict === 'inconclusive' ? 1 : 2;
    const asrBetter = (a: AsrClassification, b: AsrClassification): boolean =>
      rank(a) !== rank(b) ? rank(a) < rank(b) : a.wer < b.wer;
    /* fs-53: the QA expected text MUST be the same fs-53-normalised string the
       synth path spoke — otherwise an expanded number ("$1,200" → "one thousand
       two hundred dollars") would word-error-rate against the raw "$1,200" and
       false-flag a perfectly faithful render as `drift`. Normalise with the
       resolved `langCode` so the comparison stays aligned with the audio. fs-57
       takes the whole `group` so the vocalization carve-out below can read it. */
    /* srv-50: wrapped in the same withCallTimeout + withRecycleRecovery
       protection every synth call site already has — an unwrapped ASR call
       was the exact hang the 2026-07-03 wedged-sidecar incident exposed
       (it never threw, so nothing downstream ever got a chance to recover).
       Wrapping the closure (not either call site) covers BOTH call sites
       below automatically. */
    const verify = (pcm: Buffer, rate: number, group: SentenceGroup): Promise<AsrClassification> =>
      withRecycleRecovery(resolveGroup(group).route.engine, () =>
        withCallTimeout('asr-verify', (sig) =>
          verifySegmentTranscript(pcm, rate, normaliseForTts(group.text, langCode), {
            language: asr.language,
            nameAllowlist: asr.nameAllowlist,
            thresholds: asr.thresholds,
            transcribeFn: asr.transcribeFn,
            sidecarUrl: asr.sidecarUrl,
            signal: sig,
            /* fs-57 / srv-31: when Stage 3 prepended a vocalization, tolerate its
               leading token(s) so the gasp doesn't count as content drift. */
            ...(group.vocalization ? { vocalizationAllowlist: leadingVocalizationTokens(group.text) } : {}),
          }),
        ),
      );
    /* Sample the groups to verify (have a result + pass the stride). The stride
       walks groups-with-results in order, so `total` mirrors that ordering. */
    let sampleCounter = 0;
    const sampled: SentenceGroup[] = [];
    for (const group of groups) {
      if (!results[group.index]) continue;
      /* Stride sampling — default every sentence (sampleEvery=1). */
      if (sampleEvery > 1 && sampleCounter++ % sampleEvery !== 0) continue;
      sampled.push(group);
    }
    const totalToVerify = sampled.length;
    /* Transcribe + classify every sampled group once (the best-of-N seed). */
    const best = new Map<number, GroupResult>();
    let verifiedCount = 0;
    for (const group of sampled) {
      if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
      asr.onProgress?.({ verified: verifiedCount, total: totalToVerify });
      verifiedCount += 1;
      const r = results[group.index]!;
      best.set(group.index, r);
      const { value: verdict, ms: tMs } = await timed(() => verify(r.pcm, r.sampleRate, group));
      segmentAsrByIndex.set(group.index, verdict);
      transcribeMs += tMs;
    }
    /* Round-based re-records: each round re-synths ALL still-drift groups in one
       batched dispatch, re-verifies, and keeps the better take per group. Each
       drift group gets at most `maxAsrRerecords` re-synths (one per round) — same
       budget as the old per-group loop, batched so a round costs one call, not N. */
    for (let attempt = 1; attempt <= maxAsrRerecords; attempt++) {
      if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
      const pending = sampled.filter((g) => segmentAsrByIndex.get(g.index)!.verdict === 'drift');
      if (pending.length === 0) break;
      for (const group of pending) {
        asrRetryCountByIndex.set(group.index, (asrRetryCountByIndex.get(group.index) ?? 0) + 1);
        const c = segmentAsrByIndex.get(group.index)!;
        asr.onRerecord?.({
          group,
          attempt,
          maxRerecords: maxAsrRerecords,
          wer: c.wer,
          reasons: c.reasons,
        });
      }
      const { value: fresh, ms: asrReMs } = await timed(() => synthGroupsSerialized(pending));
      rerecordMs += asrReMs;
      for (const group of pending) {
        const f = fresh.get(group.index);
        if (!f) continue;
        const { value: freshClass, ms: revMs } = await timed(() => verify(f.pcm, f.sampleRate, group));
        transcribeMs += revMs;
        if (asrBetter(freshClass, segmentAsrByIndex.get(group.index)!)) {
          best.set(group.index, f);
          segmentAsrByIndex.set(group.index, freshClass);
        }
      }
    }
    /* Commit the best take per sampled group. */
    for (const group of sampled) {
      results[group.index] = best.get(group.index)!;
    }
  }

  /* srv-36 SPK embed pass. Runs AFTER the ASR pass (both operate on the
     now-final per-group PCM). For each stochastic-engine group (qwen or coqui)
     that meets the duration floor, embeds the raw PCM via ECAPA and collects an
     EmbeddingRow; the caller persists these as a `<slug>.embeddings.json` sibling
     via finalizeChapterAudioWrite. Gated on `qa.speaker.enabled` so it's inert
     by default (zero overhead when off). Non-fatal: a failed embed is logged and
     skipped so synthesis never breaks on a missing sidecar. */
  let spkEmbeddings: EmbeddingRow[] | undefined;
  if (configValue<boolean>('qa.speaker.enabled')) {
    const groupByIndex = new Map(groups.map((g) => [g.index, g]));
    const embT0 = Date.now();
    try {
      spkEmbeddings = await collectGroupEmbeddings(
        groups,
        results,
        (index) => resolveGroup(groupByIndex.get(index)!).configuredEngine,
        embedSegment,
        onEmbedProgress,
      );
    } catch (err) {
      console.warn(`[synthesiseChapter] render-integrity embed pass failed: ${String(err)}`);
    } finally {
      embedMs += Date.now() - embT0;
    }
  }

  /* Single index-order pass: walk `results` by group index, resample any
     mismatched rate to the anchor, append in order, and compute the final
     per-segment `startSec`/`endSec` against the now-known cumulative offset.
     This is the ONLY place audio is concatenated, so completion order can
     never reorder PCM or shuffle segment timing. */
  for (const group of groups) {
    const r = results[group.index];
    /* Defensive: a worker that returned early on abort can leave a hole.
       The abort would already have thrown out of `Promise.all`, so this is
       belt-and-braces for a future refactor. */
    if (!r) continue;
    let pcmForGroup = r.pcm;
    if (r.sampleRate !== sampleRate) {
      pcmForGroup = resamplePcm16(r.pcm, r.sampleRate, sampleRate);
    }
    const qa = segmentQaByIndex.get(group.index);
    const asrClass = segmentAsrByIndex.get(group.index);
    /* Calibration-bleed quarantine (#1083): a runaway clone that echoed its
       voice-design ref_text (the pangram) into audio must never ship, even as
       the least-bad take. The ASR re-record budget already tried to recover it
       above; if the final transcript still bleeds, drop the take — replace it
       with brief silence — and hard-flag it. Belt-and-suspenders over the
       flag-only ASR gate. */
    const quarantined =
      asrClass != null && looksLikeCalibrationBleed(asrClass.transcript, group.text);
    if (quarantined) {
      pcmForGroup = buildSilencePcm16(sampleRate, QUARANTINE_SILENCE_SEC);
      console.warn(
        `[synthesiseChapter] quarantined calibration-bleed segment (group ${group.index}): ` +
          JSON.stringify(asrClass.transcript.slice(0, 80)),
      );
    }
    const startSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(pcmForGroup);
    runningBytes += pcmForGroup.length;
    const endSec = pcmDurationSec(runningBytes, sampleRate);
    /* fs-58 (#1041) — stamp the RAW EXPLICIT instruct hash iff this group rode
       the per-group qwen-1.7b path. `resolveGroup(group).route` is POST-fallback,
       so a 1.7b group that fell back to Kokoro has a Kokoro modelKey and is
       correctly un-stamped (its audio ignored the instruct). Emotion-derived
       instructs have `group.instruct == null` and are not stamped (and hashing
       the resolved phrase would crash on undefined). */
    const groupIs17b = resolveGroup(group).route.modelKey === 'qwen3-tts-1.7b';
    const instructHash =
      group.instruct != null && groupIs17b
        ? textHashForStale(group.instruct)
        : undefined;
    segments.push({
      groupIndex: group.index,
      characterId: group.characterId,
      sentenceIds: group.sentenceIds.slice(),
      /* Stamp the hash over the TAG-STRIPPED text so it matches what the frontend
         staleness diff hashes (isChapterTextEditedSinceRender also strips). Inline audio
         tags never reach the engine, so a `[emphatic] Ende.` sentence rendered as `Ende.`
         must not read as edited. Only the tag is stripped for the hash — the further
         normaliseForTts transforms (dashes/all-caps/numbers) are ephemeral and NOT hashed,
         so both sides hash the identically tag-stripped text. group.text is usually already
         tag-stripped upstream (emotion-from-tags at analysis-persist); stripping here is
         idempotent and pins the contract for any un-migrated book too. */
      textHash: textHashForStale(stripAudioTags(group.text)),
      instructHash,
      startSec,
      endSec,
      renderedFallbackEngine: resolveGroup(group).renderedFallbackEngine,
      renderedFallbackCharacterId: resolveGroup(group).renderedFallbackCharacterId,
      voiceSubstitutedFrom: r.voiceSubstitutedFrom,
      voiceName: resolveGroup(group).voiceName,
      baseVoiceName: resolveGroup(group).baseVoiceName,
      qa,
      suspect: quarantined || qa?.status === 'suspect' ? true : undefined,
      qaRetries: qaRetryCountByIndex.get(group.index) || undefined,
      asr: asrClass,
      asrSuspect: asrClass?.verdict === 'drift' ? true : undefined,
      asrRetries: asrRetryCountByIndex.get(group.index) || undefined,
      quarantined: quarantined ? true : undefined,
    });
  }
  void completedCount;

  const pcm = Buffer.concat(chunks);
  return {
    pcm,
    sampleRate,
    durationSec: pcmDurationSec(pcm.length, sampleRate),
    segments,
    embeddings: spkEmbeddings,
    rerecordMs,
    transcribeMs,
    embedMs,
  };
}

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
import type { TtsEngine, TtsModelKey, TtsProvider, SynthesizeBatchOutput } from './index.js';
import { canonicalModelKeyForEngine } from './model-keys.js';
import { resolveCharacterEngine } from './per-character-engine.js';
import { normaliseForTts } from './text-normalize.js';
import { pcmDurationSec } from './pcm.js';
import { configValue } from '../config/resolver.js';
import { evaluateSegmentPcm, type SegmentQaVerdict, type SegmentQaThresholds } from './segment-qa.js';
import {
  verifySegmentTranscript,
  type AsrClassification,
  type AsrThresholds,
} from './segment-asr-qa.js';
import type { TranscribeResult } from './transcribe-client.js';
import { embedSegment } from './embed-client.js';
import {
  type EmbeddingRow,
} from '../audio/render-integrity/embeddings-io.js';
import { MIN_DURATION_SEC } from '../audio/render-integrity/constants.js';
import { resamplePcm16 } from './resample-pcm16.js';
import { withTtsRetry, isTransient } from './retry.js';
import { gpuSemaphore } from '../gpu/semaphore.js';

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
  constructor(characterName: string, language: string) {
    super(
      `Character "${characterName}" has no designed voice for this ${language} book — ` +
        `design a voice for it (and the narrator) in the cast view before generating. ` +
        `English Kokoro voices cannot read ${language} text.`,
    );
    this.name = 'MissingDesignedVoiceError';
  }
}

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
    Record<TtsEngine, { name: string; variants?: Partial<Record<Emotion, { name: string }>> }>
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
  /** fs-56 — per-character model-key override for the Qwen engine. When set
      on a Qwen character, the synth call uses this key instead of the run
      default (e.g. `'qwen3-tts-1.7b'` to route to the 1.7B-Base). Ignored
      for non-Qwen characters. Absent / null → run default (0.6B). */
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
}

export interface ChapterSegment {
  groupIndex: number;
  characterId: string;
  sentenceIds: number[];
  /** Inclusive start time in the chapter audio, in seconds. */
  startSec: number;
  /** Exclusive end time in the chapter audio, in seconds. */
  endSec: number;
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
  /** The voice this segment REQUESTED, set only when the sidecar substituted a
      safe fallback because the requested voice wasn't in its speaker manifest
      (its `X-Voice-Substituted-From` header). Absent on a clean render. Surfaces
      a silent voice fallback so the golden-audio gate can fail on it. */
  voiceSubstitutedFrom?: string;
  /** Per-sentence pre-assembly QA verdict (segment-qa.ts). Set only when the
      gate ran (`maxSegmentRerecords > 0`); absent on the title beat and on
      legacy chapters synthesised before the gate landed. */
  qa?: SegmentQaVerdict;
  /** True when this segment is still `suspect` after the gate exhausted its
      re-records (the best-of-N take was kept and assembled anyway). Drives the
      per-sentence suspect surface; undefined when the gate passed or did not
      run. */
  suspect?: boolean;
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
}

/** Silence padding bookending the spoken chapter-title narration. Each chapter
    MP3 now opens with `[lead silence] + [narrator: title] + [post silence] +
    [body sentences]`. Defaults match standard audiobook chapter breaks —
    3.0 s of total padding is enough for the listener to register the
    boundary without dragging. Tuned together with the documented invariant
    in `docs/features/archive/28-chapter-audio-format.md`; adjust both at once. */
const CHAPTER_LEAD_SILENCE_SEC = 1.5;
const CHAPTER_POST_TITLE_SILENCE_SEC = 1.5;

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
      whether the cast actually contains a `'narrator'` row. */
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
  /** How many sentence groups to *attempt* concurrently (plan 107). Each
      `provider.synthesize` already acquires the global `gpuSemaphore`
      (`server/src/tts/sidecar.ts`), so this width never oversubscribes the
      GPU — it only governs how many groups are dispatched before we await
      results. Defaults to `gpuSemaphore.maxConcurrency` (read from
      `GPU_CONCURRENCY` once at module load), so at the conservative default
      `GPU_CONCURRENCY=1` the width is 1 and dispatch is byte-identical to the
      old serial loop. An explicit value is mainly for tests, which need to
      exercise width>1 without touching process env. Clamped to >= 1. */
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
      An explicit small value lets tests drive the timeout deterministically. */
  callTimeoutMs?: number;
  /** How many Qwen sentences to pack per batched synth call (plan 112).
      Defaults to the module-level `QWEN_BATCH_SIZE` (env `QWEN_BATCH_SIZE`,
      default 32). `=1` disables batching (every Qwen sentence is its own
      call). Mainly an explicit value for tests, which exercise packing /
      splitting without touching process env. Clamped to >= 1. Only Qwen
      sentences are ever batched — see the dispatch partition below. */
  qwenBatchSize?: number;
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
    .filter((s) => normaliseForTts(s.text).trim() !== '')
    .map((s, i) => ({
      index: i,
      characterId: s.characterId,
      sentenceIds: [s.id],
      text: s.text,
      emotion: s.emotion,
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
    bookLanguage,
    onGroupStart,
    onGroupComplete,
    onGroupRetry,
    onBatchComplete,
    signal,
    chapterTitleNarration,
    narratorCharacterId = 'narrator',
    onTitleStart,
    onTitleComplete,
    sentenceConcurrency = gpuSemaphore.maxConcurrency,
    groupHeartbeatMs = 10_000,
    callTimeoutMs = SYNTH_CALL_TIMEOUT_MS,
    qwenBatchSize = QWEN_BATCH_SIZE,
    qwenBatchBucket = QWEN_BATCH_BUCKET,
    qwenBatchTokenBudget = QWEN_BATCH_TOKEN_BUDGET,
    maxSegmentRerecords = 0,
    segmentQaThresholds,
    onSegmentRerecord,
    asr,
    onRecoverRecycle,
    maxRecycleRecoveries = 2,
  } = opts;

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
      /* fs-56: per-character 1.7B Quality-tier — when the character carries
         a ttsModelKey and routes to Qwen, use it as the canonical model key
         so the sidecar can pick the 1.7B-Base over the 0.6B default. */
      const charModelKey =
        charEngine === 'qwen' && c.ttsModelKey
          ? canonicalModelKeyForEngine('qwen', c.ttsModelKey)
          : r.modelKey;
      return { engine: charEngine, provider: r.provider, modelKey: charModelKey };
    }
    /* Same override for the same-engine path (character on the run-default
       engine but still carrying an explicit ttsModelKey for Qwen). */
    const charModelKey =
      charEngine === 'qwen' && c.ttsModelKey
        ? canonicalModelKeyForEngine('qwen', c.ttsModelKey)
        : modelKey;
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
  ): { route: Route; voiceName: string; renderedFallbackEngine?: TtsEngine } => {
    const needsFallback =
      route.engine === 'qwen' && (!voiceName || qwenUnavailable) && !!resolveForEngine;
    if (!needsFallback || !resolveForEngine) return { route, voiceName };
    /* fs-2 — on a non-English book the Kokoro fallback is forbidden: it would
       read the book's language through an English-only voice. Fail loudly so
       the user designs the missing voice instead of shipping garbage audio. */
    if (forbidKokoroFallback) {
      throw new MissingDesignedVoiceError(c.name ?? c.id, bookLanguage ?? 'non-English');
    }
    const kokoro = resolveForEngine('kokoro');
    return {
      route: { engine: 'kokoro', provider: kokoro.provider, modelKey: kokoro.modelKey },
      voiceName: pickVoiceForEngine('kokoro', toVoiceLike(c), buildHintFromCast(c)),
      renderedFallbackEngine: 'kokoro',
    };
  };

  const castById = new Map(cast.map((c) => [c.id, c]));
  const groups = buildSentenceGroups(sentences);

  /* Pool width — how many groups we *attempt* at once. Real GPU concurrency
     is still capped by the global `gpuSemaphore` each `synthesize` acquires,
     so a width > the semaphore cap just queues; it never oversubscribes. At
     the default `GPU_CONCURRENCY=1` this is 1 → byte-identical to the old
     serial loop. Clamp to >= 1 (a width of 0 would dispatch nothing). */
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

  const titleText = chapterTitleNarration?.trim();
  if (titleText) {
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const narratorChar = castById.get(narratorCharacterId) ?? {
      id: narratorCharacterId,
      name: 'Narrator',
    };
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
      withTtsRetry(
        () =>
          titleRoute.provider.synthesize({
            text: normaliseForTts(titleText),
            voiceName: narratorVoice,
            modelKey: titleRoute.modelKey,
            signal,
          }),
        { signal },
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
    });

    onTitleComplete?.({ accumulatedSec: titleEndSec });
  }

  type GroupResult = { pcm: Buffer; sampleRate: number; voiceSubstitutedFrom?: string };

  /* Resolve a group's engine route + voice ONCE (plan 108 routing), cached by
     group index. Used by the batchability partition AND by the synth calls, so
     `pickVoiceForEngine` runs at most once per group even though both consult
     it. Mixed engines reassemble cleanly because the index-order concat below
     resamples any per-engine sample-rate mismatch to the chapter anchor. */
  type GroupRoute = { route: Route; voiceName: string; renderedFallbackEngine?: TtsEngine; configuredEngine: TtsEngine };
  const resolvedByIndex = new Map<number, GroupRoute>();
  const resolveGroup = (group: SentenceGroup): GroupRoute => {
    const cached = resolvedByIndex.get(group.index);
    if (cached) return cached;
    const character = castById.get(group.characterId) ?? { id: group.characterId };
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
       designed variant counts as a present Qwen voice. */
    const voiceForGroup = pickEmotionVariantVoice(
      baseRoute.engine,
      character.overrideTtsVoices?.qwen?.variants,
      group.emotion,
      baseVoice,
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
    const r = { ...applyQwenFallback(character, baseRoute, voiceForGroup), configuredEngine };
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
    const { route, voiceName } = resolveGroup(group);
    return withHeartbeat(group, () =>
      withCallTimeout('synthesize', (sig) =>
        withTtsRetry(
          () =>
            route.provider.synthesize({
              text: normaliseForTts(group.text),
              voiceName,
              modelKey: route.modelKey,
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
    const items = batchGroups.map((g) => {
      const { voiceName } = resolveGroup(g);
      return { text: normaliseForTts(g.text), voiceName };
    });
    const out = await withHeartbeat(lead, () =>
      withCallTimeout('batch', (sig) =>
        withTtsRetry(
          () => batchFn.call(route.provider, { items, modelKey: route.modelKey, signal: sig }),
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

  /* Partition the remaining body groups into work items: every Qwen group whose
     provider advertises `synthesizeBatch` is collected (regardless of narrative
     adjacency — a non-Qwen group interleaving doesn't break a batch) and sliced
     into `batchSize`-capped batches; everything else stays a singleton. Items
     are ordered by their first group's index so dispatch is deterministic;
     scatter-back is by `group.index`, so the final concat order is unaffected
     either way. `batchSize === 1` makes every batch a singleton — the per-call
     kill-switch. When `qwenBatchBucket` is on (plan 128) the collected
     `batchable` list is sorted by normalised-text length before slicing, so
     similar-length sentences share a batch (less padding waste); this only
     changes which groups co-occur in a batch, not the concat order. */
  const batchSize = Math.max(1, Math.floor(qwenBatchSize));
  type WorkItem =
    | { kind: 'single'; group: SentenceGroup }
    | { kind: 'batch'; groups: SentenceGroup[] };
  const isBatchable = (group: SentenceGroup): boolean => {
    const { route } = resolveGroup(group);
    return route.engine === 'qwen' && typeof route.provider.synthesizeBatch === 'function';
  };
  const workItems: WorkItem[] = [];
  /* Partition batchable groups by modelKey so 1.7B and 0.6B groups NEVER share
     a batch — the sidecar runs a single-model forward and mixing model tiers
     would cause a prompt-tensor dim mismatch. Each modelKey bucket is sorted and
     chunked independently, then the resulting work items are merged with the
     singles and sorted by first-group index before dispatch (line below). */
  const batchableByModel = new Map<string, SentenceGroup[]>();
  for (let i = bodyStartIndex; i < groups.length; i++) {
    const group = groups[i];
    if (batchSize > 1 && isBatchable(group)) {
      const { route } = resolveGroup(group);
      const bucket = batchableByModel.get(route.modelKey) ?? [];
      bucket.push(group);
      batchableByModel.set(route.modelKey, bucket);
    } else {
      workItems.push({ kind: 'single', group });
    }
  }
  /* Model-side length precomputed once across ALL batchable groups (all buckets).
     Shared by BOTH the length-bucketing sort (plan 128) and the token-budget
     packer (plan 136), so normalisation runs at most once per group. */
  const allBatchable: SentenceGroup[] = Array.from(batchableByModel.values()).flat();
  const lenOf = new Map(allBatchable.map((g) => [g, normaliseForTts(g.text).length]));
  const pushBatch = (slice: SentenceGroup[]): void => {
    workItems.push(
      slice.length === 1 ? { kind: 'single', group: slice[0] } : { kind: 'batch', groups: slice },
    );
  };
  const tokenBudget = Math.floor(qwenBatchTokenBudget);
  /* Process each per-modelKey bucket independently so a slice never crosses a
     model-tier boundary. The sort + chunking logic is identical to the pre-fix
     single-bucket path, just applied per bucket. */
  for (const batchable of batchableByModel.values()) {
    /* Length-bucketing (plan 128): order batchable groups by model-side length,
       tie-break by `group.index` for determinism. Output-preserving: scatter-back
       below is by `group.index`. */
    if (qwenBatchBucket && batchable.length > 1) {
      batchable.sort((a, b) => lenOf.get(a)! - lenOf.get(b)! || a.index - b.index);
    }
    if (tokenBudget <= 0) {
      /* Fixed-width slicing (plans 113/128) — the back-compat path and the
         kill-switch (`QWEN_BATCH_TOKEN_BUDGET` unset/0). Byte-for-byte the
         pre-136 loop. */
      for (let i = 0; i < batchable.length; i += batchSize) {
        pushBatch(batchable.slice(i, i + batchSize));
      }
    } else {
      /* Token-budget packing (plan 136): greedily fill each batch while
         `count × maxLenInBatch <= tokenBudget` AND `count <= batchSize` (the
         hard width cap). `batchable` is ascending-length-sorted when bucketing is
         on, so the candidate is normally the batch's new max; we track a running
         max so the `count × maxLen` VRAM/compute proxy stays a true upper bound
         even when bucketing is off. A single item that alone exceeds the budget
         forms its own batch (the `current.length > 0` guard never closes an empty
         batch). Output-preserving: scatter-back is still by `group.index`. */
      let current: SentenceGroup[] = [];
      let currentMax = 0;
      for (const g of batchable) {
        const candLen = lenOf.get(g)!;
        let candMax = Math.max(currentMax, candLen);
        const nextCount = current.length + 1;
        if (current.length > 0 && (nextCount * candMax > tokenBudget || nextCount > batchSize)) {
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
     `nextItem`; each runs its item, stores result(s) by `group.index`, and
     fires a per-group complete. At `poolWidth === 1` this is a serial walk. */
  let nextItem = 0;
  const effectiveWidth = Math.min(poolWidth, Math.max(1, workItems.length));
  const workers: Promise<void>[] = [];
  for (let w = 0; w < effectiveWidth; w++) {
    workers.push(
      (async () => {
        for (;;) {
          /* Cheap abort check before claiming the next item — covers the common
             case where the outer handler decides to stop (per-bookId mutex,
             request close, etc.) and the next call would otherwise burn another
             minute or two of sidecar time. The provider also receives the
             signal so a mid-call abort is honoured. */
          if (signal?.aborted) {
            throw new DOMException('synthesiseChapter aborted', 'AbortError');
          }
          const i = nextItem++;
          if (i >= workItems.length) return;
          const item = workItems[i];
          if (item.kind === 'single') {
            results[item.group.index] = await withRecycleRecovery(
              resolveGroup(item.group).route.engine,
              () => synthGroup(item.group),
            );
            fireComplete(item.group);
          } else {
            const out = await withRecycleRecovery(
              resolveGroup(item.groups[0]).route.engine,
              () => synthBatch(item.groups),
            );
            /* Scatter each batched chunk back to ITS OWN group index — this is
               what keeps the index-order concat below identical to the per-call
               path. */
            item.groups.forEach((g, k) => {
              results[g.index] = { pcm: out.pcms[k], sampleRate: out.sampleRate };
              fireComplete(g);
            });
          }
        }
      })(),
    );
  }
  await Promise.all(workers);

  /* Pre-assembly per-sentence QA gate. Every body group's PCM is now in
     `results[group.index]`, still UN-concatenated, so a bad sentence can be
     re-recorded in place before assembly (the user heard dropped / silent /
     runaway single sentences slip through the chapter-level gate, which only
     sees whole-chapter loudness + total duration). For each suspect group we
     re-synth via the same single-call `synthGroup`, keep the best take, and —
     if it still fails after `maxSegmentRerecords` attempts — keep the least-bad
     take and stamp it `suspect` (never block completion). `0` skips the gate
     entirely (byte-identical to pre-gate). Re-records run serially here, after
     the pool: a suspect sentence is the rare exception, and serial keeps the
     retake deterministic. */
  const segmentQaByIndex = new Map<number, SegmentQaVerdict>();
  if (maxSegmentRerecords > 0) {
    /* `ok` beats `suspect`; among two suspects, fewer reasons is less-bad. */
    const isBetter = (a: SegmentQaVerdict, b: SegmentQaVerdict): boolean => {
      if (a.status !== b.status) return a.status === 'ok';
      return a.reasons.length < b.reasons.length;
    };
    for (const group of groups) {
      const r = results[group.index];
      if (!r) continue;
      let best = r;
      let bestVerdict = evaluateSegmentPcm(r.pcm, r.sampleRate, group.text, segmentQaThresholds);
      for (let attempt = 1; attempt <= maxSegmentRerecords && bestVerdict.status === 'suspect'; attempt++) {
        if (signal?.aborted) {
          throw new DOMException('synthesiseChapter aborted', 'AbortError');
        }
        onSegmentRerecord?.({
          group,
          attempt,
          maxRerecords: maxSegmentRerecords,
          reasons: bestVerdict.reasons,
        });
        const fresh = await withRecycleRecovery(resolveGroup(group).route.engine, () =>
          synthGroup(group),
        );
        const freshVerdict = evaluateSegmentPcm(
          fresh.pcm,
          fresh.sampleRate,
          group.text,
          segmentQaThresholds,
        );
        if (isBetter(freshVerdict, bestVerdict)) {
          best = fresh;
          bestVerdict = freshVerdict;
        }
      }
      results[group.index] = best;
      segmentQaByIndex.set(group.index, bestVerdict);
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
  if (asr) {
    const sampleEvery = Math.max(1, Math.floor(asr.sampleEvery ?? 1));
    const maxAsrRerecords = Math.max(0, Math.floor(asr.maxRerecords ?? 0));
    /* ok < inconclusive < drift; among equal verdicts, lower WER wins. */
    const rank = (c: AsrClassification): number =>
      c.verdict === 'ok' ? 0 : c.verdict === 'inconclusive' ? 1 : 2;
    const asrBetter = (a: AsrClassification, b: AsrClassification): boolean =>
      rank(a) !== rank(b) ? rank(a) < rank(b) : a.wer < b.wer;
    const verify = (pcm: Buffer, rate: number, text: string): Promise<AsrClassification> =>
      verifySegmentTranscript(pcm, rate, text, {
        language: asr.language,
        nameAllowlist: asr.nameAllowlist,
        thresholds: asr.thresholds,
        transcribeFn: asr.transcribeFn,
        sidecarUrl: asr.sidecarUrl,
        signal,
      });
    /* Count the groups we will actually transcribe (have a result + pass the
       stride) so onProgress can report verified/total. The stride below walks
       groups-with-results in order, so total mirrors that ordering. */
    const groupsWithResult = groups.filter((g) => results[g.index]);
    const totalToVerify = groupsWithResult.filter((_, i) => i % sampleEvery === 0).length;
    let verifiedCount = 0;
    let sampleCounter = 0;
    for (const group of groups) {
      const r = results[group.index];
      if (!r) continue;
      /* Stride sampling — default every sentence (sampleEvery=1). */
      if (sampleEvery > 1 && sampleCounter++ % sampleEvery !== 0) continue;
      if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
      asr.onProgress?.({ verified: verifiedCount, total: totalToVerify });
      verifiedCount += 1;
      let best = r;
      let bestClass = await verify(r.pcm, r.sampleRate, group.text);
      for (let attempt = 1; attempt <= maxAsrRerecords && bestClass.verdict === 'drift'; attempt++) {
        if (signal?.aborted) throw new DOMException('synthesiseChapter aborted', 'AbortError');
        asr.onRerecord?.({
          group,
          attempt,
          maxRerecords: maxAsrRerecords,
          wer: bestClass.wer,
          reasons: bestClass.reasons,
        });
        const fresh = await withRecycleRecovery(resolveGroup(group).route.engine, () =>
          synthGroup(group),
        );
        const freshClass = await verify(fresh.pcm, fresh.sampleRate, group.text);
        if (asrBetter(freshClass, bestClass)) {
          best = fresh;
          bestClass = freshClass;
        }
      }
      results[group.index] = best;
      segmentAsrByIndex.set(group.index, bestClass);
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
    try {
      spkEmbeddings = await collectGroupEmbeddings(
        groups,
        results,
        (index) => resolveGroup(groupByIndex.get(index)!).configuredEngine,
      );
    } catch (err) {
      console.warn(`[synthesiseChapter] render-integrity embed pass failed: ${String(err)}`);
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
    const startSec = pcmDurationSec(runningBytes, sampleRate);
    chunks.push(pcmForGroup);
    runningBytes += pcmForGroup.length;
    const endSec = pcmDurationSec(runningBytes, sampleRate);
    const qa = segmentQaByIndex.get(group.index);
    const asrClass = segmentAsrByIndex.get(group.index);
    segments.push({
      groupIndex: group.index,
      characterId: group.characterId,
      sentenceIds: group.sentenceIds.slice(),
      startSec,
      endSec,
      renderedFallbackEngine: resolveGroup(group).renderedFallbackEngine,
      voiceSubstitutedFrom: r.voiceSubstitutedFrom,
      qa,
      suspect: qa?.status === 'suspect' ? true : undefined,
      asr: asrClass,
      asrSuspect: asrClass?.verdict === 'drift' ? true : undefined,
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
  };
}

/* Per-chapter synthesis pipeline.

   Strategy: fold the chapter's sentences into consecutive same-speaker runs
   ("sentence groups"), synthesise each group as one TTS call, then concatenate
   the PCM in narrative order. Per-group durations become segments on the
   chapter output. This dramatically cuts the call count vs per-sentence while
   still giving us per-group timing for the future playback slice. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { pickVoiceForEngine, type CharacterHint, type VoiceLike } from './voice-mapping.js';
import type { TtsEngine, TtsModelKey, TtsProvider } from './index.js';
import { normaliseForTts } from './text-normalize.js';
import { pcmDurationSec } from './pcm.js';
import { resamplePcm16 } from './resample-pcm16.js';
import { withTtsRetry } from './retry.js';

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
  attributes?: string[];
  description?: string;
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  /** cast.json stores evidence as `{ quote?, note? }[]`; `pickVoiceForEngine`
      consumes a `string[]` of bare quotes. `buildHintFromCast` does the
      flattening. */
  evidence?: Array<{ quote?: string; note?: string } | string>;
  /** Per-engine user-set voice overrides. The active synth engine reads
      its own slot; missing slots fall through to attribute inference.
      Persisted in cast.json so it survives reloads + analysis reparses.
      Switching engines (Coqui ↔ Kokoro) preserves cast assignments
      because each engine has its own slot. */
  overrideTtsVoices?: Partial<Record<TtsEngine, { name: string }>> | null;
  /** @deprecated Legacy singular override. Read paths normalise this
      into `overrideTtsVoices` at cast.json load time (see
      `normaliseCastCharacter` in routes/voices.ts). Kept on the type so
      cast.json files written by older clients still satisfy this
      interface before normalisation. */
  overrideTtsVoice?: { engine: TtsEngine; name: string } | null;
}

export interface SentenceGroup {
  /** Position in narrative order (0-based). */
  index: number;
  characterId: string;
  /** Sentence ids folded into this group, in order. */
  sentenceIds: number[];
  /** Concatenated sentence text. */
  text: string;
}

export interface ChapterSegment {
  groupIndex: number;
  characterId: string;
  sentenceIds: number[];
  /** Inclusive start time in the chapter audio, in seconds. */
  startSec: number;
  /** Exclusive end time in the chapter audio, in seconds. */
  endSec: number;
}

export interface ChapterSynthesisResult {
  /** Concatenated 16-bit signed LE mono PCM, sample rate per `sampleRate`. */
  pcm: Buffer;
  sampleRate: number;
  durationSec: number;
  segments: ChapterSegment[];
}

export interface SynthesiseChapterOpts {
  sentences: SentenceOutput[];
  cast: CastCharacter[];
  provider: TtsProvider;
  modelKey: TtsModelKey;
  /** Drives engine-specific voice catalog lookup. Must match the engine
      behind `provider` so each character's name resolves to a voice the
      engine actually has. */
  engine: TtsEngine;
  /** Notification fired *before* each group's TTS call starts. Needed because
      a single group can be a multi-minute call on CPU (e.g. a long narrator
      block folded into one synth), and without a tick at the start the SSE
      goes silent and the UI's 30s "Worker has gone quiet" banner fires for
      what is actually healthy in-progress work. Letting the route handler
      emit a "synthesising group N" tick here resets the client-side stall
      timer at each group boundary. */
  onGroupStart?: (e: { group: SentenceGroup; totalGroups: number; accumulatedSec: number }) => void;
  /** Notification on each group completion. Optional. */
  onGroupComplete?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
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
  /** Optional abort signal — checked between groups and forwarded to the
      provider so an in-flight TTS call can be cancelled mid-call. Used by
      the per-bookId server mutex to stop a stale generation handler when a
      new POST arrives for the same book. */
  signal?: AbortSignal;
}

/** Fold sentences into consecutive same-speaker groups. Order preserved. */
export function buildSentenceGroups(sentences: SentenceOutput[]): SentenceGroup[] {
  const groups: SentenceGroup[] = [];
  for (const s of sentences) {
    const last = groups[groups.length - 1];
    if (last && last.characterId === s.characterId) {
      last.sentenceIds.push(s.id);
      last.text = `${last.text} ${s.text}`.trim();
    } else {
      groups.push({
        index: groups.length,
        characterId: s.characterId,
        sentenceIds: [s.id],
        text: s.text,
      });
    }
  }
  return groups;
}

/** Build the VoiceLike payload that pickVoiceForEngine consumes from a
    confirmed-cast Character. Uses voiceId when present so the same character
    in the library stays on the same prebuilt voice; falls back to characterId.

    Passes BOTH the new per-engine map and the legacy singular field; the
    picker prefers the map when present and the synth engine matches a
    slot. The legacy field is only consulted as a fallback for cast.json
    files that haven't yet round-tripped through the normaliser. */
function toVoiceLike(c: CastCharacter): VoiceLike {
  return {
    id: c.voiceId ?? c.id,
    character: c.name,
    attributes: c.attributes ?? [],
    overrideTtsVoices: c.overrideTtsVoices ?? null,
    overrideTtsVoice: c.overrideTtsVoice ?? null,
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
    onGroupStart,
    onGroupComplete,
    onGroupRetry,
    signal,
  } = opts;

  const castById = new Map(cast.map((c) => [c.id, c]));
  const groups = buildSentenceGroups(sentences);

  const chunks: Buffer[] = [];
  const segments: ChapterSegment[] = [];
  let runningBytes = 0;
  let sampleRate = 24000; // first call sets this; default matches Gemini's documented rate.

  for (const group of groups) {
    /* Cheap abort check between groups — covers the common case where the
       outer handler decides to stop (per-bookId mutex, request close, etc.)
       and the next TTS call would otherwise burn another minute or two of
       sidecar time. The provider also receives the signal so a mid-call
       abort is honoured. */
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const character = castById.get(group.characterId) ?? { id: group.characterId };
    const voiceName = pickVoiceForEngine(
      engine,
      toVoiceLike(character),
      buildHintFromCast(character),
    );

    /* Tick BEFORE the synth call. Each TTS call can be minutes on CPU, and
       the client's stall detector only sees inactivity, not "active work on
       a long call" — so without this beat the user sees "Worker has gone
       quiet" for what is actually a healthy in-flight synth. The accumulated
       time is the running total at the *start* of this group (i.e. the end
       of the previous group), which is what the UI wants for its "line N of
       M" caption. */
    onGroupStart?.({
      group,
      totalGroups: groups.length,
      accumulatedSec: pcmDurationSec(runningBytes, sampleRate),
    });

    /* Scrub all-caps runs and em/en-dashes immediately before the synth.
       XTTS otherwise spells multi-word all-caps openers letter-by-letter
       (chapter 1's "ONE" → "oh-en-ee" in 1.15s) and loops on em-dashes,
       which together produced ~60s of garbled audio at the top of
       chapter 2 of the canonical Keeper manuscript. The transform is
       idempotent; segment metadata still references the original
       SentenceOutput so UI captions and quote audits are unaffected.

       Wrapped in `withTtsRetry` so the queue absorbs flaky transients
       (sidecar 5xx mid-load, brief connection refused while the user
       toggled Stop, network blip). Non-transient throws (4xx, poisoned
       CUDA state, retry-exhausted) bubble out of the wrapper unchanged
       and surface as today's per-chapter `chapter_failed`. */
    const result = await withTtsRetry(
      () =>
        provider.synthesize({
          text: normaliseForTts(group.text),
          voiceName,
          modelKey,
          signal,
        }),
      {
        signal,
        onRetry: (info) =>
          onGroupRetry?.({
            group,
            totalGroups: groups.length,
            attempt: info.attempt,
            backoffMs: info.backoffMs,
            reason: info.reason,
          }),
      },
    );

    /* The chapter's output rate is anchored by the first group's response.
       Subsequent groups at a mismatched rate get resampled to the anchor —
       this happens in practice when a chapter mixes Kokoro (24 kHz) and
       Coqui (22.05 kHz) characters, e.g. after a per-character engine
       override. Anchoring on the first group keeps the chapter's output
       rate stable regardless of who speaks first; rewriting the anchor
       mid-chapter would force us to retroactively resample everything we
       already concatenated. */
    let pcmForGroup = result.pcm;
    if (chunks.length === 0) {
      sampleRate = result.sampleRate;
    } else if (result.sampleRate !== sampleRate) {
      pcmForGroup = resamplePcm16(result.pcm, result.sampleRate, sampleRate);
    }

    const startSec = pcmDurationSec(runningBytes, sampleRate);
    const groupBytes = pcmForGroup.length;
    chunks.push(pcmForGroup);
    runningBytes += groupBytes;
    const endSec = pcmDurationSec(runningBytes, sampleRate);

    segments.push({
      groupIndex: group.index,
      characterId: group.characterId,
      sentenceIds: group.sentenceIds.slice(),
      startSec,
      endSec,
    });

    onGroupComplete?.({
      group,
      totalGroups: groups.length,
      accumulatedSec: endSec,
    });
  }

  const pcm = Buffer.concat(chunks);
  return {
    pcm,
    sampleRate,
    durationSec: pcmDurationSec(pcm.length, sampleRate),
    segments,
  };
}

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
    Elwin and Ro speaking in the narrator's voice. */
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
  /** Discriminator for synthetic segments that aren't backed by a manuscript
      sentence. `'title'` marks the narrator-voiced chapter-title beat
      prepended to each chapter (see CHAPTER_LEAD_SILENCE_SEC below). Body
      sentences leave this field undefined so the on-disk segments.json
      shape stays backwards-compatible with pre-title chapters. */
  kind?: 'title';
}

/** Silence padding bookending the spoken chapter-title narration. Each chapter
    MP3 now opens with `[lead silence] + [narrator: title] + [post silence] +
    [body sentences]`. Defaults match standard audiobook chapter breaks —
    3.0 s of total padding is enough for the listener to register the
    boundary without dragging. Tuned together with the documented invariant
    in `docs/features/28-chapter-audio-format.md`; adjust both at once. */
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
}

/** One group per sentence. Plan 70d — earlier code folded consecutive
    same-speaker sentences into one synth call to cut HTTP roundtrips.
    Two production failures pushed us to per-sentence:
      1. A 207-sentence narrator block on the canonical Keeper book
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
  return sentences.map((s, i) => ({
    index: i,
    characterId: s.characterId,
    sentenceIds: [s.id],
    text: s.text,
  }));
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
    chapterTitleNarration,
    narratorCharacterId = 'narrator',
    onTitleStart,
    onTitleComplete,
  } = opts;

  const castById = new Map(cast.map((c) => [c.id, c]));
  const groups = buildSentenceGroups(sentences);

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
  const titleText = chapterTitleNarration?.trim();
  if (titleText) {
    if (signal?.aborted) {
      throw new DOMException('synthesiseChapter aborted', 'AbortError');
    }
    const narratorChar =
      castById.get(narratorCharacterId) ?? { id: narratorCharacterId, name: 'Narrator' };
    const narratorVoice = pickVoiceForEngine(
      engine,
      toVoiceLike(narratorChar),
      buildHintFromCast(narratorChar),
    );

    onTitleStart?.();

    const titleResult = await withTtsRetry(
      () =>
        provider.synthesize({
          text: normaliseForTts(titleText),
          voiceName: narratorVoice,
          modelKey,
          signal,
        }),
      { signal },
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
    });

    onTitleComplete?.({ accumulatedSec: titleEndSec });
  }

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

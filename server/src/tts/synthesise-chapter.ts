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
import { pcmDurationSec } from './wav.js';

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
  onGroupStart?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
  }) => void;
  /** Notification on each group completion. Optional. */
  onGroupComplete?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
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
    in the library stays on the same prebuilt voice; falls back to characterId. */
function toVoiceLike(c: CastCharacter): VoiceLike {
  return {
    id: c.voiceId ?? c.id,
    character: c.name,
    attributes: c.attributes ?? [],
  };
}

/** Project the cast.json shape onto the CharacterHint the voice picker wants.
    Without this, `inferGender` falls back to the description/attribute scan
    and almost always returns 'unknown' (the analyzer's attributes are
    personality traits, not gendered nouns), which routes every character to
    narrator-cool. */
export function buildHintFromCast(c: CastCharacter): CharacterHint {
  const evidence = (c.evidence ?? [])
    .map(e => (typeof e === 'string' ? e : e?.quote))
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

export async function synthesiseChapter(opts: SynthesiseChapterOpts): Promise<ChapterSynthesisResult> {
  const { sentences, cast, provider, modelKey, engine, onGroupStart, onGroupComplete, signal } = opts;

  const castById = new Map(cast.map(c => [c.id, c]));
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
    const voiceName = pickVoiceForEngine(engine, toVoiceLike(character), buildHintFromCast(character));

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
       SentenceOutput so UI captions and quote audits are unaffected. */
    const result = await provider.synthesize({
      text: normaliseForTts(group.text),
      voiceName,
      modelKey,
      signal,
    });

    /* All Gemini TTS responses come back at the same rate today, but defend
       against a hypothetical mid-chapter switch — if it ever happens we'd
       need to resample, which we're not doing in this slice. */
    if (chunks.length === 0) {
      sampleRate = result.sampleRate;
    } else if (result.sampleRate !== sampleRate) {
      throw new Error(`Sample-rate change mid-chapter (${sampleRate} → ${result.sampleRate}). Resampling not implemented.`);
    }

    const startSec = pcmDurationSec(runningBytes, sampleRate);
    const groupBytes = result.pcm.length;
    chunks.push(result.pcm);
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

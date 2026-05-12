/* Per-chapter synthesis pipeline.

   Strategy: fold the chapter's sentences into consecutive same-speaker runs
   ("sentence groups"), synthesise each group as one TTS call, then concatenate
   the PCM in narrative order. Per-group durations become segments on the
   chapter output. This dramatically cuts the call count vs per-sentence while
   still giving us per-group timing for the future playback slice. */

import type { SentenceOutput } from '../handoff/schemas.js';
import { pickVoiceForEngine, type VoiceLike } from './voice-mapping.js';
import type { TtsEngine, TtsModelKey, TtsProvider } from './index.js';
import { wavDurationSec } from './wav.js';

/** Minimum surface we need from a confirmed-cast character. Matches the
    Character shape from openapi.yaml: id, voiceId, optional attributes. */
export interface CastCharacter {
  id: string;
  name?: string;
  voiceId?: string;
  attributes?: string[];
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
  /** Notification on each group completion. Optional. */
  onGroupComplete?: (e: {
    group: SentenceGroup;
    totalGroups: number;
    accumulatedSec: number;
  }) => void;
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

export async function synthesiseChapter(opts: SynthesiseChapterOpts): Promise<ChapterSynthesisResult> {
  const { sentences, cast, provider, modelKey, engine, onGroupComplete } = opts;

  const castById = new Map(cast.map(c => [c.id, c]));
  const groups = buildSentenceGroups(sentences);

  const chunks: Buffer[] = [];
  const segments: ChapterSegment[] = [];
  let runningBytes = 0;
  let sampleRate = 24000; // first call sets this; default matches Gemini's documented rate.

  for (const group of groups) {
    const character = castById.get(group.characterId) ?? { id: group.characterId };
    const voiceName = pickVoiceForEngine(engine, toVoiceLike(character));

    const result = await provider.synthesize({
      text: group.text,
      voiceName,
      modelKey,
    });

    /* All Gemini TTS responses come back at the same rate today, but defend
       against a hypothetical mid-chapter switch — if it ever happens we'd
       need to resample, which we're not doing in this slice. */
    if (chunks.length === 0) {
      sampleRate = result.sampleRate;
    } else if (result.sampleRate !== sampleRate) {
      throw new Error(`Sample-rate change mid-chapter (${sampleRate} → ${result.sampleRate}). Resampling not implemented.`);
    }

    const startSec = wavDurationSec(runningBytes, sampleRate);
    const groupBytes = result.pcm.length;
    chunks.push(result.pcm);
    runningBytes += groupBytes;
    const endSec = wavDurationSec(runningBytes, sampleRate);

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
    durationSec: wavDurationSec(pcm.length, sampleRate),
    segments,
  };
}

/* fs-52 — sentence & line-granularity cue builders. Both are pure
   reconstructions over the already-per-sentence `segments.json` array
   (plan 70d) at export time only — rendering itself is unaffected, no
   schema change. See
   docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md §4. */

import { readFile } from 'node:fs/promises';
import type { CaptionCue } from './caption-format.js';
import { textHashForStale } from '../audio/segments-io.js';
import { decodeAudioToPcm } from '../tts/mp3.js';
import { transcribeSegment } from '../tts/transcribe-client.js';

export interface SegmentInput {
  characterId: string;
  sentenceIds: number[];
  startSec: number;
  endSec: number;
  kind?: 'title';
  /** djb2-base36 hash of this segment's RAW rendered sentence text, stamped
      at synthesis time (`ChapterSegment.textHash`, `synthesise-chapter.ts`).
      Absent on the title beat and on pre-#1105 renders. Used here to
      detect a chapter whose manuscript text was edited AFTER it rendered
      but never re-rendered — the same staleness signal the frontend
      already uses to flag a chapter needing regeneration. */
  textHash?: string;
}

/** Line mode's bounded-fold ceilings (spec §4) — a cue closes once it hits
    either, in addition to always closing on a speaker change. */
export const LINE_MAX_DURATION_SEC = 7;
export const LINE_MAX_CHARS = 200;

/** Round-2-of-plan-review fix: line/sentence captions join CURRENT
    manuscript text onto STORED render-time timing — if the text was
    edited (or the chapter restructured) after it last rendered without a
    re-render, that join is silently wrong. Word mode is immune (it
    transcribes the actual audio), so this check only runs where text is
    actually joined onto stored timing. Absent `textHash` (pre-#1105
    renders) skips the check — "can't tell" stays permissive, matching how
    the frontend's own stale-chapter indicator treats the same absence. */
function assertNotStale(id: number, currentText: string, segment: SegmentInput): void {
  if (!segment.textHash) return;
  if (textHashForStale(currentText) !== segment.textHash) {
    throw new Error(
      `Sentence ${id}'s manuscript text no longer matches what this chapter's audio was ` +
        `rendered from — the chapter was edited after it last rendered. Regenerate this ` +
        `chapter before exporting captions.`,
    );
  }
}

function sentenceText(
  segment: SegmentInput,
  text: Record<number, string>,
): string {
  return segment.sentenceIds
    .map((id) => {
      const t = text[id];
      if (t === undefined) throw new Error(`No manuscript text found for sentence ${id}.`);
      assertNotStale(id, t, segment);
      return t;
    })
    .join(' ');
}

function speakerName(characterId: string, speakerNames: Record<string, string>): string {
  return speakerNames[characterId] ?? characterId;
}

export function buildSentenceCues(
  segments: SegmentInput[],
  text: Record<number, string>,
  speakerNames: Record<string, string>,
  chapterTitle: string,
): CaptionCue[] {
  return segments.map((seg) =>
    seg.kind === 'title'
      ? { startSec: seg.startSec, endSec: seg.endSec, text: chapterTitle }
      : {
          startSec: seg.startSec,
          endSec: seg.endSec,
          text: sentenceText(seg, text),
          speaker: speakerName(seg.characterId, speakerNames),
        },
  );
}

export function buildLineCues(
  segments: SegmentInput[],
  text: Record<number, string>,
  speakerNames: Record<string, string>,
  chapterTitle: string,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let fold: { characterId: string; startSec: number; endSec: number; parts: string[] } | null = null;

  const flush = () => {
    if (!fold) return;
    cues.push({
      startSec: fold.startSec,
      endSec: fold.endSec,
      text: fold.parts.join(' '),
      speaker: speakerName(fold.characterId, speakerNames),
    });
    fold = null;
  };

  for (const seg of segments) {
    if (seg.kind === 'title') {
      flush();
      cues.push({ startSec: seg.startSec, endSec: seg.endSec, text: chapterTitle });
      continue;
    }
    const segText = sentenceText(seg, text);
    if (
      fold &&
      fold.characterId === seg.characterId &&
      seg.endSec - fold.startSec <= LINE_MAX_DURATION_SEC &&
      fold.parts.join(' ').length + 1 + segText.length <= LINE_MAX_CHARS
    ) {
      fold.endSec = seg.endSec;
      fold.parts.push(segText);
    } else {
      flush();
      fold = { characterId: seg.characterId, startSec: seg.startSec, endSec: seg.endSec, parts: [segText] };
    }
  }
  flush();
  return cues;
}

/** Round-2-of-plan-review decision: a pre-#1105 render has NO `textHash`
    anywhere, so `assertNotStale` can't verify it one way or the other —
    "can't tell", not "confirmed fresh." Rather than silently treating that
    the same as verified-fresh (a downloaded caption FILE is higher-stakes
    than the frontend's soft stale-chapter badge this behaviour was
    originally modelled on), the caller (Task 7's `buildCaptions`) uses this
    to attach a non-fatal `warning` to the job rather than staying silent.
    Title-beat segments are excluded (they have no `textHash` by design,
    not by age — checking them would always report "unverifiable"). */
export function hasUnverifiableTextHash(segments: SegmentInput[]): boolean {
  return segments.some((s) => s.kind !== 'title' && !s.textHash);
}

const WORD_ASR_SAMPLE_RATE = 16000;

export interface BuildWordCuesOptions {
  language?: string | null;
  sidecarUrl?: string;
  signal?: AbortSignal;
}

/** fs-52 — one whole-chapter ASR pass (not per-sentence — see spec §2 for
    why the per-sentence draft was rejected). Words before the first body
    segment's startSec are dropped and replaced with a single fixed-timing
    title cue, matching how sentence/line mode already treat the title
    beat. */
export async function buildWordCues(
  chapterAudioPath: string,
  segments: SegmentInput[],
  chapterTitle: string,
  opts: BuildWordCuesOptions = {},
): Promise<CaptionCue[]> {
  const encoded = await readFile(chapterAudioPath);
  const pcm = await decodeAudioToPcm(encoded, WORD_ASR_SAMPLE_RATE);
  const result = await transcribeSegment(pcm, WORD_ASR_SAMPLE_RATE, {
    wordTimestamps: true,
    language: opts.language,
    sidecarUrl: opts.sidecarUrl,
    signal: opts.signal,
  });
  if (!result.words) {
    throw new Error(
      'The sidecar did not return word-level timestamps for this chapter. ' +
        'Confirm Whisper is installed and reachable, or export line/sentence captions instead.',
    );
  }

  const titleSeg = segments.find((s) => s.kind === 'title');
  const firstBodySeg = segments.find((s) => s.kind !== 'title');
  const firstBodyStartSec = firstBodySeg?.startSec ?? 0;

  const cues: CaptionCue[] = [];
  if (titleSeg) cues.push({ startSec: titleSeg.startSec, endSec: titleSeg.endSec, text: chapterTitle });
  for (const w of result.words) {
    if (w.start < firstBodyStartSec) continue;
    const word = w.word.trim();
    if (!word) continue;
    cues.push({ startSec: w.start, endSec: w.end, text: word });
  }
  return cues;
}

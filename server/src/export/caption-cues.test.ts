import { describe, it, expect } from 'vitest';
import { textHashForStale } from '../audio/segments-io.js';
import {
  buildSentenceCues,
  buildLineCues,
  hasUnverifiableTextHash,
  LINE_MAX_DURATION_SEC,
  LINE_MAX_CHARS,
  type SegmentInput,
} from './caption-cues.js';

const SPEAKERS = { narrator: 'Narrator', mira: 'Mira' };

describe('buildSentenceCues', () => {
  it('emits one cue per segment, including the title beat', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1.5, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1.5, endSec: 3.2 },
      { characterId: 'mira', sentenceIds: [2], startSec: 3.2, endSec: 4.0 },
    ];
    const text = { 1: 'It was a dark night.', 2: 'Who goes there?' };
    const cues = buildSentenceCues(segments, text, SPEAKERS, 'Chapter One');

    expect(cues).toHaveLength(3);
    expect(cues[0]).toEqual({ startSec: 0, endSec: 1.5, text: 'Chapter One' });
    expect(cues[1]).toEqual({
      startSec: 1.5,
      endSec: 3.2,
      text: 'It was a dark night.',
      speaker: 'Narrator',
    });
    expect(cues[2].speaker).toBe('Mira');
  });

  it('throws a clear error when a sentence id has no matching text', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [99], startSec: 0, endSec: 1 },
    ];
    expect(() => buildSentenceCues(segments, {}, SPEAKERS, 'Chapter One')).toThrow(/sentence 99/);
  });

  it('throws when a segment textHash no longer matches the current manuscript text (edited-since-render)', () => {
    const segments: SegmentInput[] = [
      {
        characterId: 'narrator',
        sentenceIds: [1],
        startSec: 0,
        endSec: 1,
        textHash: textHashForStale('The original rendered sentence.'),
      },
    ];
    // Text has since been edited in the manuscript but the chapter was
    // never re-rendered — the stored textHash no longer matches.
    const text = { 1: 'An edited sentence the audio never actually said.' };
    expect(() => buildSentenceCues(segments, text, SPEAKERS, 'Chapter One')).toThrow(
      /edited after it last rendered/,
    );
  });

  it('does not throw when textHash matches the current text', () => {
    const original = 'It was a dark night.';
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1, textHash: textHashForStale(original) },
    ];
    expect(() => buildSentenceCues(segments, { 1: original }, SPEAKERS, 'Chapter One')).not.toThrow();
  });

  it('does not check staleness when textHash is absent (pre-#1105 renders)', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
    ];
    expect(() => buildSentenceCues(segments, { 1: 'Anything at all.' }, SPEAKERS, 'Chapter One')).not.toThrow();
  });
});

describe('hasUnverifiableTextHash', () => {
  it('is true when any non-title segment lacks textHash', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1, textHash: 'abc' },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2 },
    ];
    expect(hasUnverifiableTextHash(segments)).toBe(true);
  });

  it('is false when every non-title segment has textHash', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1, textHash: 'abc' },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2, textHash: 'def' },
    ];
    expect(hasUnverifiableTextHash(segments)).toBe(false);
  });

  it('ignores the title beat, which never carries textHash by design', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1, endSec: 2, textHash: 'abc' },
    ];
    expect(hasUnverifiableTextHash(segments)).toBe(false);
  });
});

describe('buildLineCues', () => {
  it('folds consecutive same-speaker sentences into one cue', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2 },
      { characterId: 'mira', sentenceIds: [3], startSec: 2, endSec: 3 },
    ];
    const text = { 1: 'One.', 2: 'Two.', 3: 'Three?' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');

    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startSec: 0, endSec: 2, text: 'One. Two.', speaker: 'Narrator' });
    expect(cues[1]).toEqual({ startSec: 2, endSec: 3, text: 'Three?', speaker: 'Mira' });
  });

  it('closes the fold once combined duration exceeds LINE_MAX_DURATION_SEC, even for the same speaker', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: LINE_MAX_DURATION_SEC + 1 },
      { characterId: 'narrator', sentenceIds: [2], startSec: LINE_MAX_DURATION_SEC + 1, endSec: LINE_MAX_DURATION_SEC + 2 },
    ];
    const text = { 1: 'Long sentence.', 2: 'Next.' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');

    // Segment 1 alone already exceeds the cap — it still emits as its own
    // cue (line mode never splits within a sentence), and segment 2 starts
    // a fresh fold rather than joining it.
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('Long sentence.');
    expect(cues[1].text).toBe('Next.');
  });

  it('closes the fold once combined character count exceeds LINE_MAX_CHARS', () => {
    const long = 'x'.repeat(LINE_MAX_CHARS - 5);
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 },
      { characterId: 'narrator', sentenceIds: [2], startSec: 1, endSec: 2 },
    ];
    const text = { 1: long, 2: 'This pushes it over the cap.' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');
    expect(cues).toHaveLength(2);
  });

  it('always closes on a speaker change regardless of the caps', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 0.5 },
      { characterId: 'mira', sentenceIds: [2], startSec: 0.5, endSec: 1 },
    ];
    const text = { 1: 'Hi.', 2: 'Hello.' };
    const cues = buildLineCues(segments, text, SPEAKERS, 'Chapter One');
    expect(cues).toHaveLength(2);
  });

  it('includes the title beat as its own cue', () => {
    const segments: SegmentInput[] = [
      { characterId: 'narrator', sentenceIds: [], startSec: 0, endSec: 1.5, kind: 'title' },
      { characterId: 'narrator', sentenceIds: [1], startSec: 1.5, endSec: 2 },
    ];
    const cues = buildLineCues(segments, { 1: 'Hi.' }, SPEAKERS, 'Chapter One');
    expect(cues[0]).toEqual({ startSec: 0, endSec: 1.5, text: 'Chapter One' });
  });
});

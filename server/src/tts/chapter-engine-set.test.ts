import { describe, it, expect } from 'vitest';
import { chapterEngineSet, isMultiTts } from './chapter-engine-set.js';
import type { HasTtsEngine } from './per-character-engine.js';

const char = (ttsEngine?: HasTtsEngine['ttsEngine']): HasTtsEngine => ({ ttsEngine });

describe('chapterEngineSet', () => {
  it('returns the single default engine when no character overrides it', () => {
    const speakers = [char(), char(undefined), char(null)];
    expect(chapterEngineSet(speakers, 'kokoro')).toEqual(['kokoro']);
  });

  it('dedupes characters that share an engine', () => {
    const speakers = [char('qwen'), char('qwen'), char()];
    expect(chapterEngineSet(speakers, 'qwen')).toEqual(['qwen']);
  });

  it('sorts the engine set for stable persistence + display', () => {
    const speakers = [char('qwen'), char('coqui'), char('gemini')];
    expect(chapterEngineSet(speakers, 'kokoro')).toEqual(['coqui', 'gemini', 'qwen']);
  });

  it('narrator on default + character on qwen yields a multi-TTS set', () => {
    /* Narrator falls back to the book default (kokoro); a bespoke character
       overrides to qwen — the canonical mixed-engine chapter. */
    const speakers = [char(), char('qwen')];
    const engines = chapterEngineSet(speakers, 'kokoro');
    expect(engines).toEqual(['kokoro', 'qwen']);
    expect(isMultiTts(engines)).toBe(true);
  });

  it('a single-engine chapter is not multi-TTS', () => {
    const engines = chapterEngineSet([char(), char()], 'kokoro');
    expect(engines).toEqual(['kokoro']);
    expect(isMultiTts(engines)).toBe(false);
  });

  it('returns an empty set for no speakers (unknown)', () => {
    const engines = chapterEngineSet([], 'kokoro');
    expect(engines).toEqual([]);
    expect(isMultiTts(engines)).toBe(false);
  });
});

describe('isMultiTts', () => {
  it('is true only when the set has more than one engine', () => {
    expect(isMultiTts([])).toBe(false);
    expect(isMultiTts(['kokoro'])).toBe(false);
    expect(isMultiTts(['kokoro', 'qwen'])).toBe(true);
    expect(isMultiTts(['coqui', 'gemini', 'qwen'])).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { AUDIO_TAGS, stripAudioTags } from './audio-tags';

describe('audio-tags (frontend mirror)', () => {
  it('vocabulary matches the server closed set (drift guard)', () => {
    /* MUST equal server/src/parsers/audio-tags.ts AUDIO_TAGS. The server side pins the
       SAME literal (server/src/parsers/audio-tags.test.ts), so a tag added on one side
       only breaks a test on that side — forcing the mirror before the staleness diff can
       silently stop stripping the new tag. Keep the two literals identical. */
    expect([...AUDIO_TAGS]).toEqual([
      'emphatic',
      'shouting',
      'whispers',
      'laughs',
      'sighs',
      'excited',
      'hesitant',
    ]);
  });

  it('strips a leading tag and collapses the gap', () => {
    expect(stripAudioTags('[emphatic] Ende.')).toBe('Ende.');
  });

  it('strips a mid-sentence tag without leaving a doubled space (server contract vector)', () => {
    /* MUST equal server/src/tts/text-normalize.ts stripAudioTags for the same input —
       pinned in text-normalize.test.ts too, so a drift on either side fails loudly. */
    expect(stripAudioTags('She said [emphatic] hello.')).toBe('She said hello.');
  });

  it('is idempotent and a no-op on clean text', () => {
    expect(stripAudioTags('No one moved.')).toBe('No one moved.');
    expect(stripAudioTags(stripAudioTags('[shouting] HELP!'))).toBe('HELP!');
  });

  it('preserves arbitrary bracketed prose outside the closed vocabulary', () => {
    expect(stripAudioTags('See [Citation Needed] later.')).toBe('See [Citation Needed] later.');
  });
});

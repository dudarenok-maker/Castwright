import { describe, it, expect } from 'vitest';
import { inheritQuoteContinuations } from './quote-continuation.js';

describe('inheritQuoteContinuations', () => {
  it('reattributes narrator continuation sentences to the quote opener', () => {
    // The ch41 Springheeled-Jack shape: opener carries the “, continuations are
    // inside the still-open quote, the last one carries the closing ”.
    const lines = [
      { text: '“Good enough.', speakerId: 'jack' },
      { text: 'See, they roped me into doin’ ’em a favour.', speakerId: 'narrator' },
      { text: 'So here I am.', speakerId: 'narrator' },
      { text: 'Happy to help.”', speakerId: 'narrator' },
      { text: 'He doffed his hat and left.', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual([
      'jack',
      'jack',
      'jack',
      'jack',
      'narrator', // outside the quote — genuine narration, unchanged
    ]);
  });

  it('leaves a narration interjection between two closed quotes as narrator', () => {
    const lines = [
      { text: '“Stop,”', speakerId: 'jack' }, // opens and closes → depth 0
      { text: 'he said, turning.', speakerId: 'narrator' }, // starts outside a quote
      { text: '“Now.”', speakerId: 'jack' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual(['jack', 'narrator', 'jack']);
  });

  it('does not change a balanced single-sentence quote or the narration after it', () => {
    const lines = [
      { text: '“Hello there.”', speakerId: 'jack' },
      { text: 'She walked away.', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual(['jack', 'narrator']);
  });

  it('never overrides a continuation already attributed to a (non-narrator) speaker', () => {
    const lines = [
      { text: '“Good enough.', speakerId: 'jack' },
      { text: 'See here.', speakerId: 'stephanie' }, // already a speaker — leave it
      { text: 'Happy to help.”', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual(['jack', 'stephanie', 'jack']);
  });

  it('does nothing when the quote opener is itself unattributed (narrator)', () => {
    const lines = [
      { text: '“Good enough.', speakerId: 'narrator' },
      { text: 'See here.', speakerId: 'narrator' },
      { text: 'Happy.”', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual(['narrator', 'narrator', 'narrator']);
  });

  it('treats an apostrophe (’) as text, not a quote boundary', () => {
    const lines = [
      { text: '“They’re keepin’ him.', speakerId: 'jack' },
      { text: 'Doin’ ’em a favour.”', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual(['jack', 'jack']);
  });

  it('does not cascade past a multi-paragraph speech that reopens “ each paragraph', () => {
    // Standard EN typography for one speaker across paragraphs: an opening “ at
    // the START of each paragraph, a closing ” only at the very end. A naive
    // depth counter never returns to 0 and bleeds into the following narration.
    const lines = [
      { text: '“First paragraph of the speech.', speakerId: 'jack' },
      { text: '“Second paragraph, reopened.', speakerId: 'narrator' },
      { text: 'Still the same speech here.', speakerId: 'narrator' },
      { text: 'And the final line.”', speakerId: 'narrator' }, // closes the whole speech
      { text: 'He walked away silently.', speakerId: 'narrator' }, // narration AFTER — must stay narrator
      { text: 'The room fell quiet.', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out.map((l) => l.speakerId)).toEqual([
      'jack',
      'jack',
      'jack',
      'jack',
      'narrator',
      'narrator',
    ]);
  });

  it('returns a new array and does not mutate the input', () => {
    const lines = [
      { text: '“Good enough.', speakerId: 'jack' },
      { text: 'See here.”', speakerId: 'narrator' },
    ];
    const out = inheritQuoteContinuations(lines);
    expect(out).not.toBe(lines);
    expect(lines[1].speakerId).toBe('narrator'); // original untouched
  });

  it('handles an empty list', () => {
    expect(inheritQuoteContinuations([])).toEqual([]);
  });
});

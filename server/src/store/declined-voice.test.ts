import { describe, it, expect } from 'vitest';
import { declinesVoice } from './declined-voice.js';

describe('declinesVoice (#3992 "Don\'t reuse" marker)', () => {
  const row = { declinedVoiceFrom: ['book-two'], declinedVoiceUuids: ['u_shared'] };

  it('declines a candidate by its book', () => {
    expect(declinesVoice(row, { bookId: 'book-two', voiceUuid: 'u_other' })).toBe(true);
  });
  it('declines a candidate by the voice uuid it holds, whatever its book', () => {
    expect(declinesVoice(row, { bookId: 'book-one', voiceUuid: 'u_shared' })).toBe(true);
  });
  it('lets through a different book holding a different voice', () => {
    expect(declinesVoice(row, { bookId: 'book-one', voiceUuid: 'u_other' })).toBe(false);
    expect(declinesVoice(row, { bookId: 'book-one' })).toBe(false);
  });
  it('declines nothing for a row without the marker, or a malformed one', () => {
    expect(declinesVoice({}, { bookId: 'book-two', voiceUuid: 'u_shared' })).toBe(false);
    expect(declinesVoice(null, { bookId: 'book-two' })).toBe(false);
    expect(declinesVoice({ declinedVoiceFrom: 'book-two', declinedVoiceUuids: 7 }, { bookId: 'book-two', voiceUuid: '7' })).toBe(false);
  });
});

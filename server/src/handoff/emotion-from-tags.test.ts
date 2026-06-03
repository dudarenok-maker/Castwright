import { describe, it, expect } from 'vitest';
import { extractInlineEmotion, EMOTION_FROM_TAG } from './emotion-from-tags.js';

describe('fs-25 — extractInlineEmotion (legacy audio-tag retirement)', () => {
  it('maps the emotion-equivalent tags onto the enum', () => {
    expect(EMOTION_FROM_TAG.shouting).toBe('angry');
    expect(EMOTION_FROM_TAG.excited).toBe('excited');
    expect(EMOTION_FROM_TAG.whispers).toBe('whisper');
  });

  it('non-emotion tags map to null', () => {
    expect(EMOTION_FROM_TAG.emphatic).toBeNull();
    expect(EMOTION_FROM_TAG.laughs).toBeNull();
    expect(EMOTION_FROM_TAG.sighs).toBeNull();
    expect(EMOTION_FROM_TAG.hesitant).toBeNull();
  });

  it('seeds emotion from a mappable tag and strips the bracket', () => {
    expect(extractInlineEmotion('[shouting] Help!')).toEqual({ text: 'Help!', emotion: 'angry' });
    expect(extractInlineEmotion('[excited] Yes, please!')).toEqual({
      text: 'Yes, please!',
      emotion: 'excited',
    });
    expect(extractInlineEmotion('[whispers] hush now')).toEqual({
      text: 'hush now',
      emotion: 'whisper',
    });
  });

  it('strips a non-emotion tag without setting an emotion', () => {
    expect(extractInlineEmotion('[emphatic] really')).toEqual({ text: 'really', emotion: undefined });
  });

  it('never overrides an already-set emotion (manual/analyzer wins)', () => {
    expect(extractInlineEmotion('[shouting] Help!', 'sad')).toEqual({ text: 'Help!', emotion: 'sad' });
  });

  it('is idempotent on already-clean text', () => {
    expect(extractInlineEmotion('Help!')).toEqual({ text: 'Help!', emotion: undefined });
    expect(extractInlineEmotion('Help!', 'angry')).toEqual({ text: 'Help!', emotion: 'angry' });
  });

  it('takes the first MAPPABLE tag when several are present', () => {
    // [emphatic] is non-emotion (null), so the [shouting] wins.
    expect(extractInlineEmotion('[emphatic] [shouting] STOP').emotion).toBe('angry');
  });
});

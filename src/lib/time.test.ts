import { describe, expect, it } from 'vitest';
import { parseDuration, formatDuration } from './time';

describe('parseDuration', () => {
  it('parses MM:SS', () => {
    expect(parseDuration('12:48')).toBe(12 * 60 + 48);
    expect(parseDuration('00:45')).toBe(45);
  });

  it('parses HH:MM:SS (a chapter longer than an hour)', () => {
    expect(parseDuration('1:02:30')).toBe(3600 + 2 * 60 + 30);
  });

  it('round-trips formatDuration for both shapes (true inverse)', () => {
    for (const sec of [0, 45, 768, 3750]) {
      expect(parseDuration(formatDuration(sec))).toBe(sec);
    }
  });
});

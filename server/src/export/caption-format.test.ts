import { describe, it, expect } from 'vitest';
import { writeSrt, writeVtt, type CaptionCue } from './caption-format.js';

const CUES: CaptionCue[] = [
  { startSec: 0, endSec: 2.5, text: 'It was a dark night.', speaker: 'Narrator' },
  { startSec: 2.5, endSec: 4.125, text: 'Who goes there?', speaker: 'Mira' },
];

describe('writeSrt', () => {
  it('numbers cues sequentially and formats HH:MM:SS,mmm timestamps', () => {
    const out = writeSrt(CUES);
    expect(out).toBe(
      '1\n' +
        '00:00:00,000 --> 00:00:02,500\n' +
        'Narrator: It was a dark night.\n' +
        '\n' +
        '2\n' +
        '00:00:02,500 --> 00:00:04,125\n' +
        'Mira: Who goes there?\n' +
        '\n',
    );
  });

  it('omits the speaker prefix when speaker is absent', () => {
    const out = writeSrt([{ startSec: 0, endSec: 1, text: 'Hello.' }]);
    expect(out).toContain('Hello.\n');
    // Verify no speaker prefix by checking the pattern: text line should be just the text, not "Speaker: text"
    expect(out).not.toMatch(/\n[^:]+: Hello\./);
  });

  it('handles an hour+ timestamp', () => {
    const out = writeSrt([{ startSec: 3661.2, endSec: 3662, text: 'Later.' }]);
    expect(out).toContain('01:01:01,200 --> 01:01:02,000');
  });
});

describe('writeVtt', () => {
  it('emits a WEBVTT header and dot-separated milliseconds', () => {
    const out = writeVtt(CUES);
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).toContain('00:00:00.000 --> 00:00:02.500');
    expect(out).toContain('Narrator: It was a dark night.');
    expect(out).not.toMatch(/^\d+\n/m); // no SRT-style sequence numbers
  });
});

import { describe, it, expect } from 'vitest';
import { parseReleaseNotes, latestReleaseNote } from './release-notes';

const SAMPLE = `# Castwright 1.7.0

- **It runs on a Mac now.** Apple Silicon is first-class.
- **Your whole cast can act.** Emotion-aware voices.

# Castwright 1.6.0

- **Update from inside the app.** In-app upgrade.

# Castwright 1.5.0 — the first full Castwright

- **Any book, performed by a full cast.** The core.
`;

describe('parseReleaseNotes', () => {
  it('splits the history into newest-first sections', () => {
    const notes = parseReleaseNotes(SAMPLE);
    expect(notes.map((n) => n.version)).toEqual(['1.7.0', '1.6.0', '1.5.0']);
  });

  it('captures the heading text and bullets per section', () => {
    const [first, , third] = parseReleaseNotes(SAMPLE);
    expect(first.heading).toBe('Castwright 1.7.0');
    expect(first.bullets).toHaveLength(2);
    expect(first.bullets[0]).toContain('It runs on a Mac now');
    expect(third.heading).toContain('the first full Castwright');
    expect(third.version).toBe('1.5.0');
  });

  it('latestReleaseNote returns the top (newest) section', () => {
    expect(latestReleaseNote(SAMPLE)?.version).toBe('1.7.0');
  });

  it('is empty for placeholder/empty input', () => {
    expect(parseReleaseNotes('')).toEqual([]);
    expect(latestReleaseNote('')).toBeNull();
    expect(parseReleaseNotes('# v9.9.9\n\nSee the GitHub release for details.')[0].bullets).toEqual(
      [],
    );
  });
});

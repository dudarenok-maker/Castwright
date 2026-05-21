import { describe, it, expect } from 'vitest';
import { detectOverrideConflicts, scanCandidateChapters } from './chapter-override-conflict';

describe('scanCandidateChapters', () => {
  it('returns a single synthetic Chapter 1 when no headings match', () => {
    expect(scanCandidateChapters('Lorem ipsum dolor sit amet.')).toEqual([
      { id: 1, title: 'Chapter 1' },
    ]);
  });

  it('extracts markdown-style headings in document order', () => {
    const text = '# Prologue\n\nstuff\n\n## Part One\n\nmore\n\n# Epilogue\n';
    expect(scanCandidateChapters(text)).toEqual([
      { id: 1, title: 'Prologue' },
      { id: 2, title: 'Part One' },
      { id: 3, title: 'Epilogue' },
    ]);
  });

  it('extracts "Chapter N[: subtitle]" patterns case-insensitively', () => {
    const text = 'Chapter 1\n\nbody\n\nchapter 2: The Awakening\n\nbody\n\nCHAPTER III - Doom\n';
    expect(scanCandidateChapters(text)).toEqual([
      { id: 1, title: 'Chapter 1' },
      { id: 2, title: 'Chapter 2: The Awakening' },
      { id: 3, title: 'Chapter III: Doom' },
    ]);
  });
});

describe('detectOverrideConflicts', () => {
  it('returns empty array when no chapters carry the override flag', () => {
    const conflicts = detectOverrideConflicts(
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'Two' },
      ],
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'Two-renamed-by-reupload' },
      ],
    );
    expect(conflicts).toEqual([]);
  });

  it('returns empty array when the override title still matches the new heading', () => {
    const conflicts = detectOverrideConflicts(
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'My Renamed Two', titleOverridden: true },
      ],
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'My Renamed Two' },
      ],
    );
    expect(conflicts).toEqual([]);
  });

  it('flags a conflict when the new chapter at the same id has different content', () => {
    const conflicts = detectOverrideConflicts(
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'User-Renamed Chapter 2', titleOverridden: true },
      ],
      [
        { id: 1, title: 'One-Part-A' },
        { id: 2, title: 'One-Part-B' }, // split — new id 2 is no longer the original chapter 2
      ],
    );
    expect(conflicts).toEqual([
      {
        oldChapterId: 2,
        oldTitle: 'User-Renamed Chapter 2',
        newChapterId: 2,
        newTitle: 'One-Part-B',
      },
    ]);
  });

  it('flags a removed conflict when the new manuscript dropped the chapter slot', () => {
    const conflicts = detectOverrideConflicts(
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'Two' },
        { id: 3, title: 'Three (renamed)', titleOverridden: true },
      ],
      [
        { id: 1, title: 'One' },
        { id: 2, title: 'Two' },
      ],
    );
    expect(conflicts).toEqual([
      {
        oldChapterId: 3,
        oldTitle: 'Three (renamed)',
        newChapterId: -1,
        newTitle: '(removed)',
      },
    ]);
  });

  it('orders conflicts by the old chapter id', () => {
    const conflicts = detectOverrideConflicts(
      [
        { id: 1, title: 'A', titleOverridden: true },
        { id: 2, title: 'B', titleOverridden: true },
        { id: 3, title: 'C', titleOverridden: true },
      ],
      [
        { id: 1, title: 'X' },
        { id: 2, title: 'Y' },
        { id: 3, title: 'Z' },
      ],
    );
    expect(conflicts.map((c) => c.oldChapterId)).toEqual([1, 2, 3]);
  });
});

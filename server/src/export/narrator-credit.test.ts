/* Unit tests for narrator-credit.ts (Task 3).
   Pure logic — no filesystem or ffmpeg needed. */

import { describe, it, expect } from 'vitest';
import { DEFAULT_NARRATOR_CREDIT, artistForExport } from './narrator-credit.js';

describe('DEFAULT_NARRATOR_CREDIT', () => {
  it('is the string "Castwright"', () => {
    expect(DEFAULT_NARRATOR_CREDIT).toBe('Castwright');
  });
});

describe('artistForExport', () => {
  const author = 'Della Renwick';

  it('returns the author when narratorCredit is absent', () => {
    expect(artistForExport({ author })).toBe(author);
  });

  it('returns the author when narratorCredit is null', () => {
    expect(artistForExport({ narratorCredit: null, author })).toBe(author);
  });

  it('returns the author when narratorCredit is empty string', () => {
    expect(artistForExport({ narratorCredit: '', author })).toBe(author);
  });

  it('returns the author when narratorCredit is whitespace-only', () => {
    expect(artistForExport({ narratorCredit: '   ', author })).toBe(author);
  });

  it('returns the author when narratorCredit is the brand default "Castwright"', () => {
    expect(artistForExport({ narratorCredit: 'Castwright', author })).toBe(author);
  });

  it('returns the explicit human credit unchanged when it is a real name', () => {
    expect(artistForExport({ narratorCredit: 'Jane Narrator', author })).toBe('Jane Narrator');
  });

  it('returns a real credit even when it differs only by trimming (no sentinel match)', () => {
    /* A credit of ' Castwright ' has a real value — trim only governs the
       sentinel check, not the return value (we return the trimmed value). */
    expect(artistForExport({ narratorCredit: ' Jane Vale ', author })).toBe('Jane Vale');
  });
});

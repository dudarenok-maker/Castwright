/* Plan 72 — `bookStateAudioFormat` resolver. Pure helper: returns the
   `audioFormat` field from `BookStateJson` when present, else the
   `'mp3'` fallback that preserves backward compat for state files
   written before plan 72.

   The default keeps existing books behaving identically post-deploy:
   chapter audio still lands as `.mp3`, the encoder still dispatches
   through the libmp3lame builder, and the export pipeline still finds
   the mp3 files via `findChapterAudio` exactly as before. */

import { describe, it, expect } from 'vitest';
import { bookStateAudioFormat, type BookStateJson } from './scan.js';

function makeStateBase(): BookStateJson {
  return {
    bookId: 'demo__sa__test',
    manuscriptId: 'm_demo',
    title: 'Test',
    author: 'Test',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: [],
    coverGradient: ['#000', '#fff'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

describe('bookStateAudioFormat', () => {
  it("defaults to 'mp3' when state.audioFormat is absent (legacy books)", () => {
    expect(bookStateAudioFormat(makeStateBase())).toBe('mp3');
  });

  it('returns the persisted format when present', () => {
    expect(bookStateAudioFormat({ ...makeStateBase(), audioFormat: 'mp3' })).toBe('mp3');
    expect(bookStateAudioFormat({ ...makeStateBase(), audioFormat: 'aac-m4a' })).toBe('aac-m4a');
    expect(bookStateAudioFormat({ ...makeStateBase(), audioFormat: 'opus' })).toBe('opus');
  });

  it("falls back to 'mp3' when state.audioFormat is undefined explicitly", () => {
    expect(bookStateAudioFormat({ ...makeStateBase(), audioFormat: undefined })).toBe('mp3');
  });
});

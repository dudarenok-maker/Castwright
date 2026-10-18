/* #3700 review pass 1 — the audio-metadata backfill derives its patch from
 * `audio/<slug>.segments.json` but applies it to a FRESH state.json read. If a
 * restructure renumbered/renamed the chapter between the two (same id, new
 * slug), the old chapter's duration/model must not be stamped onto it. */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backfillAudioModelKeysFromSegments, type BookStateJson } from './scan.js';

const base = {
  bookId: 'b1',
  manuscriptId: 'm1',
  title: 'T',
  author: 'A',
  series: 'S',
  seriesPosition: 1,
  isStandalone: false,
  manuscriptFile: 'manuscript.txt',
  castConfirmed: false,
  coverGradient: ['#000', '#fff'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as const;

describe('backfillAudioModelKeysFromSegments — slug-matched patch (#3700)', () => {
  it('does not stamp a patch onto a chapter whose slug changed since the snapshot', async () => {
    const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-backfill-slug-'));
    try {
      mkdirSync(join(bookDir, 'audio'), { recursive: true });
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      writeFileSync(
        join(bookDir, 'audio', '02-old-title.segments.json'),
        JSON.stringify({ durationSec: 125, modelKey: 'kokoro', synthesizedAt: '2026-02-02T00:00:00.000Z' }),
      );
      // Snapshot the caller holds: chapter 2 is the rendered "old-title".
      const snapshot = {
        ...base,
        chapters: [{ id: 2, title: 'Old Title', slug: '02-old-title', duration: '00:00' }],
      } as unknown as BookStateJson;
      // On disk a restructure has since made id 2 a different, unrendered chapter.
      const onDisk = {
        ...base,
        chapters: [{ id: 2, title: 'New Title', slug: '02-new-title', duration: '00:00' }],
      };
      writeFileSync(join(bookDir, '.audiobook', 'state.json'), JSON.stringify(onDisk));

      await backfillAudioModelKeysFromSegments(bookDir, snapshot);

      const after = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')) as {
        chapters: Array<{ duration?: string; audioModelKey?: string }>;
      };
      expect(after.chapters[0].duration).toBe('00:00');
      expect(after.chapters[0].audioModelKey).toBeUndefined();
    } finally {
      rmSync(bookDir, { recursive: true, force: true });
    }
  });
});

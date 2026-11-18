/* #4319 review pass 2 — a format switch whose stale other-extension previous
   cannot be removed must still leave exactly ONE live file, the new take.
   Without it the preserve aborts, the old live file stays, and mp3 (probed
   first) serves the OLD take against the new take's segments. Real ffmpeg, the
   real `finalizeChapterAudioWrite`. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'Switch Author';
const SERIES = 'Standalones';
const TITLE = 'Switch Story';
const SLUG = 'chapter-one';
const SR = 8_000;

let workspaceRoot: string;

function tone(sec: number): Buffer {
  const n = Math.round(sec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return buf;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-finalize-switch-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('finalize across a container switch with an undeletable stale previous', () => {
  it('mp3 then aac-m4a: exactly one live file exists and it is the new take', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    const { makeBookId } = await import('../workspace/paths.js');
    const { liveAudioFiles, findChapterAudio } = await import('../workspace/chapter-take.js');
    const bookId = makeBookId(AUTHOR, SERIES, TITLE);
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    const audioRoot = join(bookDir, 'audio');
    mkdirSync(audioRoot, { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId: 'm_test',
        title: TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:00' }],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    const render = (sec: number, audioFormat: 'mp3' | 'aac-m4a') =>
      finalizeChapterAudioWrite({
        bookId,
        bookDir,
        chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
        pcm: tone(sec),
        sampleRate: SR,
        durationSec: sec,
        segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: sec }],
        cast: [{ id: 'amy', name: 'Amy', gender: 'female' as const, attributes: [] }],
        castIdHistory: { schema: 1 as const, supersededBy: {} },
        defaultEngine: 'kokoro' as const,
        modelKey: 'kokoro-v1' as const,
        audioFormat,
        resynthesizedIndices: 'all' as const,
      });

    await render(1.0, 'mp3');
    /* A directory where the stale previous would be: unlink cannot remove it. */
    mkdirSync(join(audioRoot, `${SLUG}.previous.m4a`));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await render(2.0, 'aac-m4a');
    } finally {
      warn.mockRestore();
    }

    expect(liveAudioFiles(audioRoot, SLUG).map((f) => f.ext)).toEqual(['m4a']);
    expect(findChapterAudio(audioRoot, SLUG)?.ext).toBe('m4a');
    expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(false);
    expect(JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8')).durationSec).toBe(2);
  }, 30_000);
});

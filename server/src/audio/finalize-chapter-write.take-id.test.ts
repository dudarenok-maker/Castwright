/* #4319 review pass 1, finding 4 — after a take id is minted, a re-render must
   not leave `state.json`'s `audioTakeId` naming the PREVIOUS take. Finalize
   stamps the take members over `TAKE_STATE_FIELDS` (the single list), and its
   own segments carry no id yet, so the stale id is dropped. Real ffmpeg, the
   real `finalizeChapterAudioWrite`, the real take identity mint. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'TakeId Author';
const SERIES = 'Standalones';
const TITLE = 'TakeId Story';
const SLUG = 'chapter-one';
const SR = 8_000;

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let bookId: string;

const readJsonFile = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const stateChapter = () => readJsonFile(join(bookDir, '.audiobook', 'state.json')).chapters[0];

function tone(sec: number): Buffer {
  const n = Math.round(sec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return buf;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-finalize-takeid-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('finalize vs state.json audioTakeId', () => {
  it('render, mint, render again: audioTakeId is not the previous take id', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    const { makeBookId } = await import('../workspace/paths.js');
    const { withBookOp } = await import('../workspace/book-op-lock.js');
    const { ensureTakeIdentity } = await import('../workspace/chapter-take.js');
    bookId = makeBookId(AUTHOR, SERIES, TITLE);
    bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    audioRoot = join(bookDir, 'audio');
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
    const render = (sec: number) =>
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
        audioFormat: 'mp3' as const,
        resynthesizedIndices: 'all' as const,
      });

    await render(1.0);
    await withBookOp(bookId, (h) => ensureTakeIdentity(h, SLUG));
    const firstId = readJsonFile(join(audioRoot, `${SLUG}.segments.json`)).takeId;
    expect(stateChapter().audioTakeId).toBe(firstId);

    await render(2.0);

    expect(stateChapter().audioTakeId).not.toBe(firstId);
    expect(readJsonFile(join(audioRoot, `${SLUG}.previous.segments.json`)).takeId).toBe(firstId);
  });
});

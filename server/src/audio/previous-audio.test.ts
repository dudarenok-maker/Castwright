/* Plan 285 Task 3 — the A/B audio steps, moved unchanged from
   routes/chapter-audio.ts. These pin TODAY's behaviour, including the
   delete-then-rename residual filed as #3456. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { failRename } = vi.hoisted(() => ({ failRename: { value: false } }));
vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...real,
    renameWithRetry: async (src: string, dest: string) => {
      if (failRename.value && src.endsWith('.previous.mp3')) throw new Error('EBUSY: simulated');
      return real.renameWithRetry(src, dest);
    },
  };
});

import { acceptPreviousAudio, restorePreviousAudio, findPreviousChapterAudio } from './previous-audio.js';

const SLUG = '01-one';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'previous-audio-'));
  failRename.value = false;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const p = (name: string) => join(root, name);

describe('findPreviousChapterAudio', () => {
  it('returns null without a .previous.mp3, and the mp3 descriptor with one', () => {
    expect(findPreviousChapterAudio(root, SLUG)).toBeNull();
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    expect(findPreviousChapterAudio(root, SLUG)).toEqual({
      path: p(`${SLUG}.previous.mp3`),
      ext: 'mp3',
      mime: 'audio/mpeg',
      urlSuffix: 'audio.mp3',
    });
  });
});

describe('acceptPreviousAudio', () => {
  it("answers 'none' when nothing is preserved", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('none');
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(true);
  });

  it("deletes both .previous files, leaves live, answers 'deleted'", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{}');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('deleted');
    expect(existsSync(p(`${SLUG}.previous.mp3`))).toBe(false);
    expect(existsSync(p(`${SLUG}.previous.segments.json`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('LIVE');
  });
});

describe('restorePreviousAudio', () => {
  it("answers 'none' and touches nothing when nothing is preserved", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    expect(await restorePreviousAudio(root, SLUG)).toBe('none');
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('LIVE');
  });

  it("promotes .previous over live (audio + segments) and answers 'restored'", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.segments.json`), '{"live":true}');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{"prev":true}');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('PREV');
    expect(JSON.parse(readFileSync(p(`${SLUG}.segments.json`), 'utf8'))).toEqual({ prev: true });
    expect(existsSync(p(`${SLUG}.previous.mp3`))).toBe(false);
  });

  it('today: a live .m4a is deleted and .previous comes back as .mp3', async () => {
    writeFileSync(p(`${SLUG}.m4a`), 'LIVE-M4A');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(existsSync(p(`${SLUG}.m4a`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('PREV');
  });

  it('today: a failed rename throws AFTER the live take was deleted; .previous stays intact', async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    failRename.value = true;
    await expect(restorePreviousAudio(root, SLUG)).rejects.toThrow(/simulated/);
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.previous.mp3`), 'utf8')).toBe('PREV');
  });
});

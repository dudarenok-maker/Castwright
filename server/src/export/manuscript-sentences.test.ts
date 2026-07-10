import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadManuscriptSentencesByChapter } from './manuscript-sentences.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function makeBookDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'manuscript-sentences-test-'));
  dirs.push(root);
  mkdirSync(join(root, '.audiobook'), { recursive: true });
  return root;
}

describe('loadManuscriptSentencesByChapter', () => {
  it('groups sentences by chapterId then sentence id', async () => {
    const bookDir = makeBookDir();
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({
        sentences: [
          { id: 1, chapterId: 1, characterId: 'narrator', text: 'It was a dark night.' },
          { id: 2, chapterId: 1, characterId: 'mira', text: 'Who goes there?' },
          { id: 1, chapterId: 2, characterId: 'narrator', text: 'Chapter two begins.' },
        ],
      }),
    );

    const result = await loadManuscriptSentencesByChapter(bookDir);

    expect(result).not.toBeNull();
    expect(result![1][1].text).toBe('It was a dark night.');
    expect(result![1][2].characterId).toBe('mira');
    expect(result![2][1].text).toBe('Chapter two begins.');
  });

  it('returns null when manuscript-edits.json is absent', async () => {
    const bookDir = makeBookDir();
    const result = await loadManuscriptSentencesByChapter(bookDir);
    expect(result).toBeNull();
  });

  it('returns null when the sentences array is empty', async () => {
    const bookDir = makeBookDir();
    writeFileSync(
      join(bookDir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences: [] }),
    );
    const result = await loadManuscriptSentencesByChapter(bookDir);
    expect(result).toBeNull();
  });
});

/* #3507 — which chapters an export covers. Raw bytes stand in for audio:
   only existence is probed. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { exportableChapters } from './exportable-chapters.js';
import {
  removeTakes,
  seedCorruptCache,
  seedTakes,
} from '../test-utils/analysis-takes.js';
import type { BookStateJson } from '../workspace/scan.js';

const MANUSCRIPT_ID = 'mns_3507_exportable';

function makeState(overrides: Partial<BookStateJson> = {}): BookStateJson {
  return {
    manuscriptId: MANUSCRIPT_ID,
    chapters: [
      { id: 3, title: 'Three', slug: '03-three' },
      { id: 1, title: 'One', slug: '01-one' },
      { id: 2, title: 'Two', slug: '02-two' },
      { id: 4, title: 'Front matter', slug: '00-front-matter', excluded: true },
    ],
    ...overrides,
  } as BookStateJson;
}

describe('exportableChapters (#3507)', () => {
  let bookDir: string;

  beforeAll(() => {
    bookDir = mkdtempSync(join(tmpdir(), 'exportable-chapters-'));
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    writeFileSync(join(bookDir, 'audio', '01-one.mp3'), 'take');
  });

  afterEach(() => removeTakes(MANUSCRIPT_ID));
  afterAll(() => rmSync(bookDir, { recursive: true, force: true }));

  const ids = async (state: BookStateJson) =>
    (await exportableChapters(bookDir, state)).map((c) => c.id);

  it('returns the non-excluded chapters in id order, minus a no-text chapter with no audio', async () => {
    await seedTakes(MANUSCRIPT_ID, { 1: 'words', 2: 'empty', 3: 'words' });
    expect(await ids(makeState())).toEqual([1, 3]);
  });

  it('keeps a no-text chapter that has live audio', async () => {
    await seedTakes(MANUSCRIPT_ID, { 1: 'empty', 2: 'empty', 3: 'words' });
    expect(await ids(makeState())).toEqual([1, 3]);
  });

  it('drops nothing when every chapter would be left out, so the export refuses them', async () => {
    await seedTakes(MANUSCRIPT_ID, { 2: 'empty', 3: 'empty' });
    const state = makeState({
      chapters: [
        { id: 2, title: 'Two', slug: '02-two' },
        { id: 3, title: 'Three', slug: '03-three' },
      ],
    });
    expect(await ids(state)).toEqual([2, 3]);
  });

  it('drops nothing for a book with no manuscriptId', async () => {
    await seedTakes(MANUSCRIPT_ID, { 2: 'empty' });
    expect(await ids(makeState({ manuscriptId: '' }))).toEqual([1, 2, 3]);
  });

  it('drops nothing when the analysis cache fails to load', async () => {
    await seedCorruptCache(MANUSCRIPT_ID);
    expect(await ids(makeState())).toEqual([1, 2, 3]);
  });
});

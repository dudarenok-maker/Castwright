/* #2254 — `buildManuscriptRecord(bookDir, state)` is the post-lookup body of
   hydrateFromDisk. It must return exactly the record `getOrHydrateManuscript`
   builds for the same book, and (unlike the lookup) never write state.json. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AUTHOR = 'Build Record';
const SERIES = 'Standalones';
const TITLE = 'Build Record Book';
const MANUSCRIPT_ID = 'm_build_record';
const MANUSCRIPT = '# Alpha\n\nFirst paragraph of alpha.\n\nSecond paragraph of alpha.\n';

let workspaceRoot: string;
let bookDir: string;
let statePath: string;
let state: import('../workspace/scan.js').BookStateJson;

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'build-record-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), MANUSCRIPT);
  statePath = join(bookDir, '.audiobook', 'state.json');
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(async () => {
  const { makeBookId } = await import('../workspace/paths.js');
  const { removeManuscript } = await import('./manuscripts.js');
  removeManuscript(MANUSCRIPT_ID);
  state = {
    bookId: makeBookId(AUTHOR, SERIES, TITLE),
    manuscriptId: MANUSCRIPT_ID,
    title: TITLE,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.md',
    castConfirmed: true,
    chapters: [{ id: 1, title: 'Alpha', slug: '01-alpha', uuid: 'u-alpha-1' }],
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as import('../workspace/scan.js').BookStateJson;
  writeFileSync(statePath, JSON.stringify(state));
  rmSync(join(bookDir, '.audiobook', 'manuscript-hints.json'), { force: true });
});

describe('buildManuscriptRecord', () => {
  it('equals the hydrated record for a book with no hints file, and leaves state.json untouched', async () => {
    const { buildManuscriptRecord, getOrHydrateManuscript, removeManuscript } = await import('./manuscripts.js');
    const before = readFileSync(statePath);
    const built = await buildManuscriptRecord(bookDir, state);
    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(built?.hintsSource).toBe('parse');
    removeManuscript(MANUSCRIPT_ID);
    const hydrated = await getOrHydrateManuscript(MANUSCRIPT_ID);
    expect(hydrated).toBeDefined();
    expect(built).toEqual(hydrated);
  });

  it('equals the hydrated record when a valid manuscript-hints.json exists', async () => {
    const { buildManuscriptRecord, getOrHydrateManuscript, removeManuscript } = await import('./manuscripts.js');
    const { buildHintsEntry, composeHintsFile, writeManuscriptHints, sha256Hex } = await import(
      '../workspace/manuscript-hints.js'
    );
    const sha = sha256Hex(Buffer.from(MANUSCRIPT));
    const entry = buildHintsEntry({
      manuscriptId: MANUSCRIPT_ID,
      manuscriptFile: 'manuscript.md',
      sourceSha256: sha,
      hints: [{ id: 1, body: 'A restructured body that differs from the parse.' }],
      stateChapters: state.chapters,
    });
    await writeManuscriptHints(bookDir, composeHintsFile(entry, null, state, sha));

    const before = readFileSync(statePath);
    const built = await buildManuscriptRecord(bookDir, state);
    expect(readFileSync(statePath).equals(before)).toBe(true);
    expect(built?.hintsSource).toBe('persisted');
    expect(built?.chapterHints[0]?.body).toBe('A restructured body that differs from the parse.');
    removeManuscript(MANUSCRIPT_ID);
    const hydrated = await getOrHydrateManuscript(MANUSCRIPT_ID);
    expect(built).toEqual(hydrated);
  });
});

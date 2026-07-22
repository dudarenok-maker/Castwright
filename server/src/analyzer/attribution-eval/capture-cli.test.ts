import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bookDir = mkdtempSync(join(tmpdir(), 'cap-book-'));
mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
writeFileSync(
  join(bookDir, '.audiobook', 'manuscript-edits.json'),
  JSON.stringify({ sentences: [
    { id: 1, chapterId: 44, characterId: 'narrator', text: 'He said.' },
    { id: 2, chapterId: 44, characterId: 'valkyrie', text: 'Hi.' },
    // Task 8 — prior chapter's final two-speaker exchange (feeds silver capture).
    { id: 10, chapterId: 43, characterId: 'valkyrie', text: 'Are you coming?' },
    { id: 11, chapterId: 43, characterId: 'skulduggery', text: 'Right behind you.' },
  ] }),
);
writeFileSync(
  join(bookDir, '.audiobook', 'cast.json'),
  JSON.stringify({ characters: [
    { id: 'narrator', name: 'Narrator' },
    { id: 'valkyrie', name: 'Valkyrie Cain', gender: 'female' },
    { id: 'skulduggery', name: 'Skulduggery Pleasant' },
  ] }),
);

vi.mock('../../workspace/scan.js', () => ({
  findBookByBookId: vi.fn(async () => ({
    bookDir, author: 'Derek Landy', title: 'Playing with Fire',
    state: { manuscriptId: 'm_pwf', author: 'Derek Landy', title: 'Playing with Fire', language: 'en' },
  })),
  bookStateLanguage: (s: { language?: string }) => s.language ?? 'en',
}));
vi.mock('../../store/manuscripts.js', () => ({
  getOrHydrateManuscript: vi.fn(async () => ({
    chapterHints: [
      { id: 43, title: 'Ch43', body: 'RAW BODY 43' },
      { id: 44, title: 'Ch44', body: 'RAW BODY 44' },
    ],
  })),
}));

import { captureCorpus, captureSilverCorpus } from './capture-cli.js';

describe('captureCorpus', () => {
  const corpusDir = mkdtempSync(join(tmpdir(), 'cap-corpus-'));
  it('writes a labelled fixture + roster snapshot', async () => {
    const res = await captureCorpus({ bookId: 'b_pwf', chapters: [44], corpusDir });
    expect(res.writtenFixtures).toHaveLength(1);
    const fixture = JSON.parse(readFileSync(res.writtenFixtures[0], 'utf8'));
    expect(fixture.chapterText).toContain('RAW BODY 44');
    expect(fixture.lines).toEqual([
      { text: 'He said.', speakerId: 'narrator' },
      { text: 'Hi.', speakerId: 'valkyrie' },
    ]);
    const roster = JSON.parse(readFileSync(res.rosterPath, 'utf8'));
    expect(roster.characters.find((c: any) => c.id === 'valkyrie').gender).toBe('female');
  });
});

describe('captureSilverCorpus (Task 8)', () => {
  const corpusDir = mkdtempSync(join(tmpdir(), 'cap-silver-corpus-'));
  it('writes a .silver.labelled.json skeleton seeded from current attribution, with the prior chapter exchange attached', async () => {
    const res = await captureSilverCorpus({ bookId: 'b_pwf', chapters: [44], corpusDir });
    expect(res.writtenFixtures).toHaveLength(1);
    expect(res.writtenFixtures[0]).toMatch(/\.silver\.labelled\.json$/);
    const fixture = JSON.parse(readFileSync(res.writtenFixtures[0], 'utf8'));
    expect(fixture.chapterText).toContain('RAW BODY 44');
    expect(fixture.lines).toEqual([
      { text: 'He said.', speakerId: 'narrator' },
      { text: 'Hi.', speakerId: 'valkyrie' },
    ]);
    expect(fixture.priorExchange).toEqual({
      turns: [
        { speakerId: 'valkyrie', speakerName: 'Valkyrie Cain', text: 'Are you coming?' },
        { speakerId: 'skulduggery', speakerName: 'Skulduggery Pleasant', text: 'Right behind you.' },
      ],
    });
  });

  it('omits priorExchange for a chapter with no preceding chapter', async () => {
    const res = await captureSilverCorpus({ bookId: 'b_pwf', chapters: [43], corpusDir });
    const fixture = JSON.parse(readFileSync(res.writtenFixtures[0], 'utf8'));
    expect(fixture.priorExchange).toBeUndefined();
  });
});

/* #2254 notice A — the mock import mirrors the server's merged-paragraph flag
   (MERGED_TURNS_DEGRADED = 10 openers on one line, notice languages only). */
import { describe, it, expect } from 'vitest';
import { mockImportManuscript } from './api';

const opener = 'Он вздохнул. — Да';
const line = (n: number) => 'Начало ' + Array.from({ length: n }, () => opener).join(' ');

describe('mockImportManuscript — paragraphsMerged (#2254)', () => {
  it('flags the chapter when a ru line has 10 openers', async () => {
    const res = await mockImportManuscript({ text: line(10), fileName: 'a.txt' });
    expect(res.candidate.chapters[0]).toHaveProperty('paragraphsMerged', true);
  });

  it('leaves the key absent at 9 openers', async () => {
    const res = await mockImportManuscript({ text: line(9), fileName: 'a.txt' });
    expect(res.candidate.chapters[0]).not.toHaveProperty('paragraphsMerged');
  });

  it('leaves the key absent for an English text with 10 openers', async () => {
    const en = Array.from({ length: 10 }, () => 'He sighed. — Yes').join(' ');
    const res = await mockImportManuscript({ text: en, fileName: 'a.txt' });
    expect(res.candidate.language).toBe('en');
    expect(res.candidate.chapters[0]).not.toHaveProperty('paragraphsMerged');
  });
});

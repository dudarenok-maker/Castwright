/* fs-2 — the analysis route resolves a manuscript's book language once per job
   and threads it into every analyzer `runStage*` call (so the preamble + the
   Cyrillic token estimate fire for a Russian book). This pins the resolver —
   Task 6c (#2246) call-site parity: the book's `language` when found; `'en'`
   only for the genuinely pre-confirm carve-outs (no book on disk yet, or a
   scan *lookup* failure); and a THROWN `BookLanguageUnsetError` for a *located*
   book that never declared a language (the old whole-body `catch { return 'en' }`
   made that a silent no-op). The spread of `language: bookLanguage` into the
   call objects is typecheck-guaranteed; the analyzer's USE of `call.language`
   is covered in gemini.test.ts / ollama.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookStateJson } from '../workspace/scan.js';

const findBookByManuscriptId = vi.fn();
vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return { ...actual, findBookByManuscriptId };
});

function located(language?: string | null) {
  const state = { manuscriptId: 'm1', language } as unknown as BookStateJson;
  return { bookDir: '/x', author: 'A', series: 'S', title: 'T', state };
}

beforeEach(() => {
  findBookByManuscriptId.mockReset();
});

describe('resolveBookLanguageForManuscript', () => {
  it("returns the book's normalised language when found", async () => {
    const { resolveBookLanguageForManuscript } = await import('./analysis.js');
    findBookByManuscriptId.mockResolvedValue(located('ru'));
    expect(await resolveBookLanguageForManuscript('m1')).toBe('ru');
  });

  it("throws BookLanguageUnsetError for a *located* book that never declared a language", async () => {
    /* Task 6c — the whole point of the carve-out: a book that EXISTS on disk
       but never declared a language is a fact, not English. The honest strict
       reader must throw; the old `catch { return 'en' }` swallow is the no-op
       trap this task exists to close. Name-matched rather than instanceof
       (scan.js is mocked below, so a top-level value import would break the
       factory's hoisting). */
    const { resolveBookLanguageForManuscript } = await import('./analysis.js');
    findBookByManuscriptId.mockResolvedValue(located(undefined));
    await expect(resolveBookLanguageForManuscript('m1')).rejects.toMatchObject({
      name: 'BookLanguageUnsetError',
    });
    findBookByManuscriptId.mockResolvedValue(located(null));
    await expect(resolveBookLanguageForManuscript('m1')).rejects.toMatchObject({
      name: 'BookLanguageUnsetError',
    });
    findBookByManuscriptId.mockResolvedValue(located('   '));
    await expect(resolveBookLanguageForManuscript('m1')).rejects.toMatchObject({
      name: 'BookLanguageUnsetError',
    });
  });

  it("the carve-out: 'en' when the book is found but no book is on disk (located === null)", async () => {
    /* Task 6c carve-out (b) — located === null is PRE-CONFIRM: there is no
       book on disk yet, so there is no language to have been set, and the
       'choose it in Book settings' error would be nonsense. Must survive. */
    const { resolveBookLanguageForManuscript } = await import('./analysis.js');
    findBookByManuscriptId.mockResolvedValue(null);
    expect(await resolveBookLanguageForManuscript('m_missing')).toBe('en');
  });

  it("swallows a scan error to 'en' (analysis must never be blocked by the lookup)", async () => {
    const { resolveBookLanguageForManuscript } = await import('./analysis.js');
    findBookByManuscriptId.mockRejectedValue(new Error('disk gone'));
    expect(await resolveBookLanguageForManuscript('m1')).toBe('en');
  });
});

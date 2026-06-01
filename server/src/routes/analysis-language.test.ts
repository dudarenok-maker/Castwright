/* fs-2 — the analysis route resolves a manuscript's book language once per job
   and threads it into every analyzer `runStage*` call (so the preamble + the
   Cyrillic token estimate fire for a Russian book). This pins the resolver:
   the book's `language` when found, 'en' when the book isn't on disk yet, and
   'en' (never a throw) when the scan blows up. The spread of `language:
   bookLanguage` into the call objects is typecheck-guaranteed; the analyzer's
   USE of `call.language` is covered in gemini.test.ts / ollama.test.ts. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BookStateJson } from '../workspace/scan.js';

const findBookByManuscriptId = vi.fn();
vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return { ...actual, findBookByManuscriptId };
});

function located(language?: string) {
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

  it("defaults to 'en' for a book with no language field", async () => {
    const { resolveBookLanguageForManuscript } = await import('./analysis.js');
    findBookByManuscriptId.mockResolvedValue(located(undefined));
    expect(await resolveBookLanguageForManuscript('m1')).toBe('en');
  });

  it("returns 'en' when no book is found on disk", async () => {
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

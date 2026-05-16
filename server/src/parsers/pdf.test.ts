// Pairs with docs/features/06-manuscript-parsing.md (PDF parser).
//
// parsePdf is a thin wrapper around pdf-parse — its real job is metadata
// precedence (info-dict Title/Author > parseText-derived) and delegating
// body splitting to parseText. Mocking pdf-parse isolates that contract;
// pdfjs end-to-end correctness is covered by the canonical e2e manuscript
// run (see CLAUDE.md, docs/features/28-chapter-audio-format.md).

import { describe, expect, it, vi, beforeEach } from 'vitest';

const pdfParseMock = vi.fn();
vi.mock('pdf-parse', () => ({ default: (...args: unknown[]) => pdfParseMock(...args) }));

/* Mock pdfjs-dist so each test controls the outline payload. The mocked
   getDocument returns a stub whose getOutline() resolves to whatever
   `outlineMock` is set to. Returning null mimics a PDF with no outline. */
let outlineMock: unknown = null;
let getDocumentShouldThrow = false;
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  getDocument: () => {
    if (getDocumentShouldThrow) throw new Error('mock pdfjs failure');
    return {
      promise: Promise.resolve({
        getOutline: async () => outlineMock,
        destroy: async () => undefined,
      }),
    };
  },
}));

import { parsePdf } from './pdf.js';

beforeEach(() => {
  pdfParseMock.mockReset();
  outlineMock = null;
  getDocumentShouldThrow = false;
});

describe('parsePdf', () => {
  it('returns format: "pdf"', async () => {
    pdfParseMock.mockResolvedValue({ text: 'Chapter 1\nHello.', info: {} });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.format).toBe('pdf');
  });

  it('uses the info-dict Title in preference to the text-derived title', async () => {
    pdfParseMock.mockResolvedValue({
      text: '# Inner title\n\nbody',
      info: { Title: 'Outer Metadata Title' },
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('Outer Metadata Title');
  });

  it('falls back to the parseText-derived title when info.Title is missing', async () => {
    pdfParseMock.mockResolvedValue({ text: '# Inner title\n\nbody', info: {} });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('Inner title');
  });

  it('exposes the info-dict Author when present', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'body',
      info: { Author: 'Jane Doe' },
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.author).toBe('Jane Doe');
  });

  it('info-dict Author wins over filename-derived author', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'body',
      info: { Author: 'Jane Doe' },
    });
    const out = await parsePdf(Buffer.from(''), {
      fileName: 'Other Author - Series 01 - Title.pdf',
    });
    expect(out.author).toBe('Jane Doe');
  });

  it('falls back to filename-derived author when info-dict Author absent', async () => {
    pdfParseMock.mockResolvedValue({ text: 'body', info: {} });
    const out = await parsePdf(Buffer.from(''), {
      fileName: 'Jane Doe - Solway Bay 02 - Riptide.pdf',
    });
    expect(out.author).toBe('Jane Doe');
  });

  it('delegates body splitting to parseText — chapter headings in the extracted text become chapters', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nfirst body\n\nChapter 2\nsecond body',
      info: {},
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('propagates filename-derived series metadata onto the result', async () => {
    pdfParseMock.mockResolvedValue({ text: 'body', info: {} });
    const out = await parsePdf(Buffer.from(''), {
      fileName: 'Jane Doe - Solway Bay 04 - Sample.pdf',
    });
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(4);
  });

  it('tolerates a missing info dict (undefined)', async () => {
    pdfParseMock.mockResolvedValue({ text: 'just body', info: undefined });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('x'); // filename stem, since text had no H1
    expect(out.author).toBeNull();
  });

  it('trims whitespace around info-dict Title and Author', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'body',
      info: { Title: '  The Title  ', Author: '  Jane Doe  ' },
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('The Title');
    expect(out.author).toBe('Jane Doe');
  });
});

describe('parsePdf — outline-based chapter title replacement', () => {
  it('replaces chapter titles with outline entries when counts match', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nbody one\n\nChapter 2\nbody two',
      info: {},
    });
    outlineMock = [
      { title: 'The Berth at Liverpool' },
      { title: 'A Manifest Two Names Short' },
    ];
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map(c => c.title)).toEqual([
      'The Berth at Liverpool',
      'A Manifest Two Names Short',
    ]);
  });

  it('filters front-matter outline entries (Copyright, Acknowledgements) before alignment', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nfirst\n\nChapter 2\nsecond',
      info: {},
    });
    outlineMock = [
      { title: 'Copyright' },                       // filtered
      { title: 'Dedication' },                      // filtered
      { title: 'The Berth at Liverpool' },          // chapter 1
      { title: 'A Manifest Two Names Short' },      // chapter 2
    ];
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map(c => c.title)).toEqual([
      'The Berth at Liverpool',
      'A Manifest Two Names Short',
    ]);
  });

  it('keeps parseText titles when filtered outline count differs from chapter count (misalignment guard)', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nfirst\n\nChapter 2\nsecond',
      info: {},
    });
    outlineMock = [
      { title: 'The Berth at Liverpool' },
      { title: 'A Manifest Two Names Short' },
      { title: 'What the Captain Knew' },           // one too many
    ];
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map(c => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('keeps parseText titles when no outline is present', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nfirst\n\nChapter 2\nsecond',
      info: {},
    });
    outlineMock = null;
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map(c => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('keeps parseText titles when the outline is an empty array', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nbody',
      info: {},
    });
    outlineMock = [];
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map(c => c.title)).toEqual(['Chapter 1']);
  });

  it('tolerates getDocument throwing — falls back to parseText titles, no crash', async () => {
    pdfParseMock.mockResolvedValue({
      text: 'Chapter 1\nbody',
      info: {},
    });
    getDocumentShouldThrow = true;
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map(c => c.title)).toEqual(['Chapter 1']);
  });
});

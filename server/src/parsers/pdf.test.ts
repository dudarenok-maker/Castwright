// Pairs with docs/features/archive/02-upload-paste-or-file.md (PDF parser).
//
// parsePdf is a thin wrapper around pdf-parse — its real job is metadata
// precedence (info-dict Title/Author > parseText-derived), outline-based
// title replacement, and delegating body splitting to parseText. Mocking
// pdf-parse isolates that contract; the REAL pdf-parse 2 wiring (text +
// getInfo().outline, no '-- N of M --' page markers) is covered by
// pdf-real.test.ts against a committed fixture.

import { describe, expect, it, vi, beforeEach } from 'vitest';

/* pdf-parse 2 is class-based (new PDFParse({data}).getText()/getInfo()/destroy()).
   The mock returns whatever `pdfResult` is set to, isolating parsePdf's metadata-
   precedence + parseText-delegation + outline-replacement contract. setPdf() is
   the per-test setter. getInfo() yields both `info` (the raw PDF Info dict, with
   Title/Author) and `outline` (the bookmark tree) — mirroring the real v2, which
   serves text + metadata + outline from one PDFParse instance (no separate pdfjs). */
let pdfResult: { text: string; info: unknown; outline: unknown } = {
  text: '',
  info: {},
  outline: null,
};
const setPdf = (r: { text: string; info: unknown; outline?: unknown }) => {
  pdfResult = { outline: null, ...r };
};
vi.mock('pdf-parse', () => ({
  PDFParse: class {
    async getText() {
      return { text: pdfResult.text };
    }
    async getInfo() {
      return { info: pdfResult.info, outline: pdfResult.outline };
    }
    async destroy() {}
  },
}));

import { parsePdf } from './pdf.js';

beforeEach(() => {
  pdfResult = { text: '', info: {}, outline: null };
});

describe('parsePdf', () => {
  it('returns format: "pdf"', async () => {
    setPdf({ text: 'Chapter 1\nHello.', info: {} });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.format).toBe('pdf');
  });

  it('uses the info-dict Title in preference to the text-derived title', async () => {
    setPdf({
      text: '# Inner title\n\nbody',
      info: { Title: 'Outer Metadata Title' },
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('Outer Metadata Title');
  });

  it('falls back to the parseText-derived title when info.Title is missing', async () => {
    setPdf({ text: '# Inner title\n\nbody', info: {} });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('Inner title');
  });

  it('exposes the info-dict Author when present', async () => {
    setPdf({
      text: 'body',
      info: { Author: 'Jane Doe' },
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.author).toBe('Jane Doe');
  });

  it('info-dict Author wins over filename-derived author', async () => {
    setPdf({
      text: 'body',
      info: { Author: 'Jane Doe' },
    });
    const out = await parsePdf(Buffer.from(''), {
      fileName: 'Other Author - Series 01 - Title.pdf',
    });
    expect(out.author).toBe('Jane Doe');
  });

  it('falls back to filename-derived author when info-dict Author absent', async () => {
    setPdf({ text: 'body', info: {} });
    const out = await parsePdf(Buffer.from(''), {
      fileName: 'Jane Doe - Solway Bay 02 - Riptide.pdf',
    });
    expect(out.author).toBe('Jane Doe');
  });

  it('delegates body splitting to parseText — chapter headings in the extracted text become chapters', async () => {
    setPdf({
      text: 'Chapter 1\nfirst body\n\nChapter 2\nsecond body',
      info: {},
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('propagates filename-derived series metadata onto the result', async () => {
    setPdf({ text: 'body', info: {} });
    const out = await parsePdf(Buffer.from(''), {
      fileName: 'Jane Doe - Solway Bay 04 - Sample.pdf',
    });
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(4);
  });

  it('tolerates a missing info dict (undefined)', async () => {
    setPdf({ text: 'just body', info: undefined });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.title).toBe('x'); // filename stem, since text had no H1
    expect(out.author).toBeNull();
  });

  it('trims whitespace around info-dict Title and Author', async () => {
    setPdf({
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
    setPdf({
      text: 'Chapter 1\nbody one\n\nChapter 2\nbody two',
      info: {},
      outline: [{ title: 'The Berth at Liverpool' }, { title: 'A Manifest Two Names Short' }],
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual([
      'The Berth at Liverpool',
      'A Manifest Two Names Short',
    ]);
  });

  it('filters front-matter outline entries (Copyright, Acknowledgements) before alignment', async () => {
    setPdf({
      text: 'Chapter 1\nfirst\n\nChapter 2\nsecond',
      info: {},
      outline: [
        { title: 'Copyright' }, // filtered
        { title: 'Dedication' }, // filtered
        { title: 'The Berth at Liverpool' }, // chapter 1
        { title: 'A Manifest Two Names Short' }, // chapter 2
      ],
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual([
      'The Berth at Liverpool',
      'A Manifest Two Names Short',
    ]);
  });

  it('keeps parseText titles when filtered outline count differs from chapter count (misalignment guard)', async () => {
    setPdf({
      text: 'Chapter 1\nfirst\n\nChapter 2\nsecond',
      info: {},
      outline: [
        { title: 'The Berth at Liverpool' },
        { title: 'A Manifest Two Names Short' },
        { title: 'What the Captain Knew' }, // one too many
      ],
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('keeps parseText titles when no outline is present (getInfo().outline null)', async () => {
    setPdf({
      text: 'Chapter 1\nfirst\n\nChapter 2\nsecond',
      info: {},
      outline: null,
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
  });

  it('keeps parseText titles when the outline is an empty array', async () => {
    setPdf({
      text: 'Chapter 1\nbody',
      info: {},
      outline: [],
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1']);
  });

  it('tolerates a malformed outline (non-array) — falls back to parseText titles, no crash', async () => {
    setPdf({
      text: 'Chapter 1\nbody',
      info: {},
      outline: { not: 'an array' },
    });
    const out = await parsePdf(Buffer.from(''), { fileName: 'x.pdf' });
    expect(out.chapters.map((c) => c.title)).toEqual(['Chapter 1']);
  });
});

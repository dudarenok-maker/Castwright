// Pairs with docs/features/archive/52-mobi-parsing.md.
//
// parseMobi wraps @lingo-reader/mobi-parser. Following the pdf.test.ts
// pattern, the upstream library is mocked so each case exercises a
// specific contract — DRM detection, AZW3 ext routing, TOC label
// resolution, metadata precedence, audio-tag enrichment. End-to-end
// MOBI parsing against a real Project Gutenberg file is the manual
// verification step in plan 52; see "Verification" there.

import { describe, expect, it, vi, beforeEach } from 'vitest';

let lastInitMobiCalledWith: { data: Uint8Array; resourceDir: string } | null = null;
let lastInitKf8CalledWith: { data: Uint8Array; resourceDir: string } | null = null;

interface MockMetadata {
  title?: string;
  author?: string[];
  publisher?: string;
}
interface MockTocItem {
  label: string;
  href: string;
  children?: MockTocItem[];
}
interface MockChapter {
  id: string;
  html: string;
}

let metadataMock: MockMetadata = {};
let tocMock: MockTocItem[] = [];
let chaptersMock: MockChapter[] = [];

function makeMockParser() {
  return {
    getMetadata: () => metadataMock,
    getToc: () => tocMock,
    getSpine: () => chaptersMock.map((c) => ({ id: c.id })),
    loadChapter: (id: string) => {
      const found = chaptersMock.find((c) => c.id === id);
      return found ? { html: found.html, css: [] } : undefined;
    },
    destroy: () => undefined,
  };
}

vi.mock('@lingo-reader/mobi-parser', () => ({
  initMobiFile: async (data: Uint8Array, resourceDir: string) => {
    lastInitMobiCalledWith = { data, resourceDir };
    return makeMockParser();
  },
  initKf8File: async (data: Uint8Array, resourceDir: string) => {
    lastInitKf8CalledWith = { data, resourceDir };
    return makeMockParser();
  },
}));

import { parseMobi, DrmProtectedError } from './mobi.js';

/* Build a minimal MOBI-shaped Buffer with a controllable encryption byte
   at the PalmDOC header position. PDB header is 78 bytes; record 0
   offset is at byte 78 (u32 BE); encryption type sits at record0Offset +
   0x0C (u16 BE). We pad to 256 bytes so reads don't fall off the end.
   Used by the DRM tests below — no real MOBI parsing happens because
   the library is mocked, but readMobiEncryptionType runs against the
   buffer bytes before the mock is reached. */
function mobiBufferWithEncryption(encType: number): Buffer {
  const buf = Buffer.alloc(256, 0);
  /* Record 0 starts at offset 96 (arbitrary but past the PDB header). */
  const record0 = 96;
  buf.writeUInt32BE(record0, 78);
  buf.writeUInt16BE(encType, record0 + 0x0c);
  return buf;
}

beforeEach(() => {
  lastInitMobiCalledWith = null;
  lastInitKf8CalledWith = null;
  metadataMock = {};
  tocMock = [];
  chaptersMock = [];
});

describe('parseMobi — DRM guard', () => {
  it('throws DrmProtectedError when encryption byte is 1 (old Mobipocket DRM)', async () => {
    const buf = mobiBufferWithEncryption(1);
    await expect(parseMobi(buf, { fileName: 'book.mobi' })).rejects.toBeInstanceOf(
      DrmProtectedError,
    );
  });

  it('throws DrmProtectedError when encryption byte is 2 (Kindle Store DRM)', async () => {
    const buf = mobiBufferWithEncryption(2);
    await expect(parseMobi(buf, { fileName: 'book.mobi' })).rejects.toThrow(/DRM-protected/);
  });

  it('does not invoke the library when DRM is detected', async () => {
    const buf = mobiBufferWithEncryption(2);
    chaptersMock = [{ id: 'c1', html: '<p>Body</p>' }];
    await expect(parseMobi(buf, { fileName: 'book.mobi' })).rejects.toBeInstanceOf(
      DrmProtectedError,
    );
    expect(lastInitMobiCalledWith).toBeNull();
    expect(lastInitKf8CalledWith).toBeNull();
  });

  it('proceeds when encryption byte is 0 (no DRM)', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>Hello world.</p>' }];
    const out = await parseMobi(buf, { fileName: 'book.mobi' });
    expect(out.format).toBe('mobi');
    expect(out.chapters).toHaveLength(1);
  });
});

describe('parseMobi — ext routing', () => {
  it('uses initMobiFile for .mobi files', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>x</p>' }];
    await parseMobi(buf, { fileName: 'book.mobi' });
    expect(lastInitMobiCalledWith).not.toBeNull();
    expect(lastInitKf8CalledWith).toBeNull();
  });

  it('uses initKf8File for .azw3 files', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>x</p>' }];
    await parseMobi(buf, { fileName: 'book.azw3' });
    expect(lastInitKf8CalledWith).not.toBeNull();
    expect(lastInitMobiCalledWith).toBeNull();
  });

  it('falls back to initMobiFile when no filename is supplied', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>x</p>' }];
    await parseMobi(buf, {});
    expect(lastInitMobiCalledWith).not.toBeNull();
  });
});

describe('parseMobi — metadata', () => {
  it('returns format: "mobi"', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>body</p>' }];
    const out = await parseMobi(buf, { fileName: 'book.mobi' });
    expect(out.format).toBe('mobi');
  });

  it('uses the library metadata title when present', async () => {
    const buf = mobiBufferWithEncryption(0);
    metadataMock = { title: 'The Real Title' };
    chaptersMock = [{ id: 'c1', html: '<p>body</p>' }];
    const out = await parseMobi(buf, { fileName: 'whatever.mobi' });
    expect(out.title).toBe('The Real Title');
  });

  it('falls back to filename-derived metadata when library has no title', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>body</p>' }];
    /* FILENAME_RE in text.ts expects `Author - Series N - Title` (space-N-
       space, not `#N`); see server/src/parsers/text.ts:139. */
    const out = await parseMobi(buf, {
      fileName: 'Tolkien - Lord of the Rings 2 - The Two Towers.mobi',
    });
    expect(out.title).toBe('The Two Towers');
    expect(out.author).toBe('Tolkien');
    expect(out.series).toBe('Lord of the Rings');
    expect(out.seriesPosition).toBe(2);
  });

  it('exposes the first author from the metadata author array', async () => {
    const buf = mobiBufferWithEncryption(0);
    metadataMock = { title: 'X', author: ['Jane Doe', 'Co Author'] };
    chaptersMock = [{ id: 'c1', html: '<p>body</p>' }];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.author).toBe('Jane Doe');
  });
});

describe('parseMobi — chapters', () => {
  it('turns each spine entry into a chapter', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [
      { id: 'c1', html: '<p>First chapter body.</p>' },
      { id: 'c2', html: '<p>Second chapter body.</p>' },
    ];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters).toHaveLength(2);
  });

  it('strips HTML tags but keeps visible text', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>The tower stood at the edge of the world.</p>' }];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    const body = out.chapters[0].body;
    expect(body).toContain('The tower stood at the edge of the world.');
    expect(body).not.toContain('<p>');
  });

  it('converts <em> emphasis into [emphatic] audio tags', async () => {
    /* The audio-tag vocabulary uses [emphatic] (not [emphasis]) — see
       server/src/parsers/audio-tags.ts:7. tagHtmlEmphasis emits
       `[emphatic] <body>` form (lead tag, no closing tag). */
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>She was <em>very</em> tired.</p>' }];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters[0].body).toMatch(/\[emphatic\]\s+very/);
  });

  it('uses TOC labels as chapter titles when present', async () => {
    const buf = mobiBufferWithEncryption(0);
    tocMock = [
      { label: 'The Berth at Liverpool', href: 'c1' },
      { label: 'Storm at Sea', href: 'c2' },
    ];
    chaptersMock = [
      { id: 'c1', html: '<p>body 1</p>' },
      { id: 'c2', html: '<p>body 2</p>' },
    ];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters.map((c) => c.title)).toEqual([
      'The Berth at Liverpool',
      'Storm at Sea',
    ]);
  });

  it('merges generic TOC label with body <h1> when the heading is descriptive', async () => {
    const buf = mobiBufferWithEncryption(0);
    tocMock = [{ label: 'Chapter 1', href: 'c1' }];
    chaptersMock = [
      { id: 'c1', html: '<h1>The Berth at Liverpool</h1><p>body</p>' },
    ];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters[0].title).toBe('Chapter 1 — The Berth at Liverpool');
  });

  it('drops the body <h1> once it is promoted to the title (no duplicate-title audio)', async () => {
    /* The <h1> is spoken by synthesise-chapter's title beat; without this guard
       it ALSO leads the body, so the listener hears the chapter name twice. */
    const buf = mobiBufferWithEncryption(0);
    tocMock = [{ label: 'Chapter 1', href: 'c1' }];
    chaptersMock = [
      { id: 'c1', html: '<h1>The Berth at Liverpool</h1><p>It was a cold morning.</p>' },
    ];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters[0].title).toBe('Chapter 1 — The Berth at Liverpool');
    expect(out.chapters[0].body).toBe('It was a cold morning.');
  });

  it('falls back to "Chapter N" when neither TOC nor body heading is present', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '<p>bare body</p>' }];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters[0].title).toBe('Chapter 1');
  });

  it('skips spine entries with empty HTML', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [
      { id: 'c1', html: '' },
      { id: 'c2', html: '<p>real body</p>' },
    ];
    const out = await parseMobi(buf, { fileName: 'x.mobi' });
    expect(out.chapters).toHaveLength(1);
    expect(out.chapters[0].body).toContain('real body');
  });

  it('throws when the spine yields no extractable text', async () => {
    const buf = mobiBufferWithEncryption(0);
    chaptersMock = [{ id: 'c1', html: '' }];
    await expect(parseMobi(buf, { fileName: 'x.mobi' })).rejects.toThrow(
      /no extractable text/i,
    );
  });
});

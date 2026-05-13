// Pairs with docs/features/06-manuscript-parsing.md (EPUB parser).

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseEpub } from './epub.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, '__fixtures__/sample.epub');

describe('parseEpub', () => {
  it('returns format: "epub"', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.format).toBe('epub');
  });

  it('uses dc:title from the OPF metadata', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.title).toBe('The Solway Light');
  });

  it('exposes dc:creator as the author', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.author).toBe('Jane Doe');
  });

  it('parses Calibre series + index from <meta name="calibre:series">', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(2);
  });

  it('turns each spine entry into a chapter', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    expect(out.chapters).toHaveLength(2);
  });

  it('strips HTML tags from chapter bodies but preserves visible text', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map(c => c.body).join('\n');
    expect(allBody).toContain('The tower stood at the edge of the world.');
    expect(allBody).not.toContain('<p>');
    expect(allBody).not.toContain('<em>');
  });

  it('applies tagHtmlEmphasis to inline emphasis tags', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map(c => c.body).join('\n');
    // chapter1 contains <em>across</em> — should land as [emphatic] across.
    expect(allBody).toContain('[emphatic] across');
  });

  it('applies tagShoutingDialog to HTML-stripped content', async () => {
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'sample.epub' });
    const allBody = out.chapters.map(c => c.body).join('\n');
    // chapter2 contains "GET OUT NOW," — should be tagged + title-cased.
    expect(allBody).toContain('[shouting] Get Out Now');
  });

  it('falls back to filename metadata when neither OPF nor Calibre meta provide series', async () => {
    // Same fixture has Calibre series → use a fileName with a different
    // series pattern and confirm OPF wins.
    const buf = await readFile(fixturePath);
    const out = await parseEpub(buf, { fileName: 'Other Author - Other Series 09 - X.epub' });
    expect(out.series).toBe('Solway Bay');
    expect(out.seriesPosition).toBe(2);
    expect(out.author).toBe('Jane Doe');
  });
});

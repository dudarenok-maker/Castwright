/* EPUB parser via epub2. Joins each spine entry as a chapter, stripping HTML
   tags to plain text. The book's dc:title becomes the manuscript title. */

import { EPub } from 'epub2';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChapterHint } from '../store/manuscripts.js';
import type { ParsedManuscript } from './text.js';

function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function parseEpub(buffer: Buffer, opts: { fileName?: string }): Promise<ParsedManuscript> {
  const tmp = await mkdtemp(join(tmpdir(), 'epub-'));
  const filePath = join(tmp, opts.fileName ?? 'book.epub');
  await writeFile(filePath, buffer);
  try {
    // epub2's createAsync returns the parsed EPub instance.
    const epub = await EPub.createAsync(filePath);
    const title = (epub.metadata.title ?? '').trim();
    const chapters: ChapterHint[] = [];

    for (let i = 0; i < epub.flow.length; i++) {
      const entry = epub.flow[i];
      if (!entry?.id) continue;
      const html = await new Promise<string>((resolve, reject) => {
        epub.getChapter(entry.id!, (err: Error | null, text?: string) => err ? reject(err) : resolve(text ?? ''));
      });
      const body = stripHtml(html);
      if (!body) continue;
      const chTitle = entry.title?.trim() || `Chapter ${chapters.length + 1}`;
      chapters.push({ id: chapters.length + 1, title: chTitle, body });
    }

    if (chapters.length === 0) {
      throw new Error('EPUB had no extractable text in its spine.');
    }

    const sourceText = chapters.map(c => c.body).join('\n\n');
    return {
      format: 'epub',
      title: title || opts.fileName?.replace(/\.[^.]+$/, '') || 'Untitled EPUB',
      sourceText,
      chapters,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
